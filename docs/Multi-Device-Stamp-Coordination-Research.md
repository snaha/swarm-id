# Research: Multi-Device Postage Stamp Coordination

## Problem Statement

The `UtilizationAwareStamper` in `lib/src/utils/batch-utilization.ts` tracks 65,536 buckets (Uint32Array), each with up to `2^(batchDepth-16)` slots (e.g., 16 at depth 20, 256 at depth 24). When multiple devices/tabs share the same identity and postage batch, each maintains its own local copy of these counters (cached in IndexedDB). Without coordination, two devices can assign the same bucket:slot pair, causing:

1. **Data loss** — mutable stamps allow overwriting, so the second write silently replaces the first
2. **Incorrect utilization state** — each device's counter diverges from reality

### Key Constraint: Dynamic Active Device Count

A user may have many registered devices (laptop, phone, desktop, iPad, etc.) but typically only **~2 devices write simultaneously**. This means:

- **Static interleaving by total registered devices is too wasteful** — if 6 devices are registered but only 2 are writing, interleaving by 6 wastes ~67% of slot capacity
- At batch depth 20 (16 slots/bucket), interleaving by 6 leaves only ~2 slots per device per bucket
- **Real-time presence detection is needed** to know which devices are *actively writing*, so interleaving can be dynamic (e.g., interleave by 2 when 2 are active)

---

## Approach 1: Same-Device Tab Coordination (BroadcastChannel + SharedWorker)

The most common collision case: multiple tabs on the same browser.

| Aspect | Details |
|--------|---------|
| **How** | A `SharedWorker` owns the authoritative `UtilizationAwareStamper`. All tabs delegate stamping to it. `BroadcastChannel` broadcasts state updates for UI consistency. `Web Locks API` prevents concurrent stamp operations. |
| **Browser support** | All modern browsers (SharedWorker not in Safari on iOS, BroadcastChannel works everywhere) |
| **Infrastructure** | None — native browser APIs |
| **Latency** | Sub-millisecond |
| **Complexity** | Very low |

**Verdict**: Should be implemented regardless of cross-device solution. Solves the most common scenario with zero infrastructure.

---

## Approach 2: Cross-Device — Real-Time Presence + Dynamic Interleaved Slots

The core idea: devices that are **actively writing** discover each other in real time, agree on a count N, and interleave slot assignments so collisions are impossible.

### The Slot Interleaving Mechanism

Once N active devices are known, device `i` (0-indexed) uses:
```
nextSlot(bucket) = DATA_COUNTER_START + i + (localCounter[bucket] * N)
```

With N=2 and depth 24 (256 slots): each device gets 126 slots/bucket — plenty.
With N=2 and depth 20 (16 slots): each device gets 6 slots/bucket — tight but workable.

### The Remaining Problem: How Do Devices Discover Each Other?

This is where the technology choices matter. The devices need:
1. **Presence**: "I'm about to write / am actively writing"
2. **Agreement**: "There are N active writers, I am device index i"
3. **Liveness**: "Device j stopped writing / went offline"

Below are the technology options for solving this, ordered by alignment with Swarm philosophy:

---

## Technology Options for Real-Time Presence

### Option A: GSOC via Shared Bee Node (Swarm-Native, Works Today)

Both devices connect to a Bee node (for uploads). If that node is a **full node**, GSOC provides real-time pub/sub:

- Devices subscribe to a GSOC reference via WebSocket (`bee.gsocSubscribe()`)
- A device writes a SOC update as a "heartbeat" / "I'm writing" signal
- The Bee node detects the SOC update and pushes a WebSocket notification to all subscribers
- Heartbeats every few seconds; missed heartbeats = device offline

| Aspect | Details |
|--------|---------|
| **Infrastructure** | Requires a full Bee node (not just a gateway) — but users may already have one |
| **Latency** | Low — WebSocket push, typically sub-second |
| **Complexity** | Moderate — need to set up GSOC mining, heartbeat protocol |
| **Decentralized** | Partially — still requires a specific Bee node as intermediary |
| **Limitation** | Both devices must connect to the same Bee node (or a node in the same neighborhood). Does not work across different gateways unless they are full nodes in the same neighborhood. |
| **Stamp cost** | Each heartbeat SOC uses a stamp slot — need to account for this |

**Verdict**: Good fit if users run their own Bee node. Aligns with Swarm ecosystem. Doesn't work well with third-party gateways.

---

### Option B: libp2p with WebRTC (Fully Decentralized)

Browser-to-browser communication via js-libp2p's WebRTC transport.

| Aspect | Details |
|--------|---------|
| **How** | Browsers establish direct WebRTC DataChannels via libp2p. Once connected, exchange presence heartbeats and slot assignments directly. |
| **Transports** | WebRTC (browser-to-browser), WebSocket/WebTransport (browser-to-server) |
| **Peer discovery** | Needs a Circuit Relay V2 node for initial WebRTC signaling (SDP exchange). After that, direct P2P. |
| **Infrastructure** | Circuit Relay V2 node + STUN servers. Could potentially use an existing Bee node or Swarm infrastructure node as the relay. |
| **Complexity** | High — libp2p stack includes Noise encryption, Yamux multiplexing, protocol negotiation |
| **Connection setup** | 2-5 seconds |
| **Reliability** | ~85-90% direct connection success; symmetric NAT may require TURN fallback |
| **Browser support** | All browsers with WebRTC (all modern browsers) |
| **Decentralized** | Yes — data path is fully P2P after connection |

**Considerations specific to this project**:
- Bee uses Go libp2p (v0.33.2) with TCP + optional WebSocket transports
- js-libp2p is a separate implementation but interoperable at the protocol level
- Could potentially reuse Bee infrastructure (bootnodes) for relay, but Bee's libp2p is configured for TCP, not WebRTC
- The Bee node could be extended to act as a Circuit Relay V2, but that's a significant change

**Verdict**: Technically the most decentralized option. Worth considering if the project will need general P2P communication beyond just stamp coordination. The infrastructure requirement (relay node) is the main barrier, but it's a lightweight component.

---

### Option C: Nostr Relay (Semi-Decentralized, Low Infrastructure)

Use public Nostr relays for device presence signaling.

| Aspect | Details |
|--------|---------|
| **How** | Each device publishes encrypted Nostr events as heartbeats. Other devices subscribe to the same filter. Ephemeral events (kind 20000-29999) for presence. |
| **Infrastructure** | Public Nostr relays (free, many available). No self-hosting required. |
| **Latency** | ~100-500ms per message via relay |
| **Complexity** | Low-moderate — Nostr protocol is simple (JSON events + WebSocket) |
| **Libraries** | `nostr-tools` (lightweight), NDK (full-featured) |
| **Reliability** | Dependent on relay uptime; use multiple relays for redundancy |
| **Privacy** | Events are signed with Nostr keypairs; can derive from existing Swarm identity |

**Considerations**:
- Nostr's ephemeral events are designed exactly for transient signaling
- Can encrypt coordination messages using NIP-44 (gift-wrapped events)
- No account registration needed — just generate a keypair (can derive from Swarm identity)
- Many free, stable public relays (e.g., relay.damus.io, nos.lol)
- Falls gracefully to single-device mode if relays are unreachable

**Verdict**: Pragmatic middle ground. Low infrastructure burden, reasonable latency for presence detection, philosophically compatible with decentralization. The dependency on external relays is a concern but mitigated by relay redundancy and graceful fallback.

---

### Option D: Simple WebSocket Coordination Server (Centralized)

A dedicated lightweight server for presence and coordination.

| Aspect | Details |
|--------|---------|
| **How** | Devices connect via WebSocket. Server tracks active writers and broadcasts presence updates. |
| **Infrastructure** | A hosted WebSocket server (can be very lightweight — ~100 lines of code) |
| **Latency** | Excellent (~1-5ms) |
| **Complexity** | Very low |
| **Reliability** | Excellent (standard WebSocket infrastructure is mature) |
| **Decentralized** | No — central point of failure |

**Verdict**: Simplest and most reliable option. Contradicts decentralization philosophy but could serve as a pragmatic first step or fallback.

---

### Option E: SOC Feed Polling (Swarm-Native, No Real-Time)

Poll Swarm SOC feeds for presence instead of real-time detection.

| Aspect | Details |
|--------|---------|
| **How** | Before starting an upload batch, a device writes a "writing" SOC to a known feed topic, then reads the feed to see who else is active. Heartbeat via periodic SOC writes. |
| **Latency** | Seconds (Swarm upload + download per check) |
| **Infrastructure** | None beyond existing Bee node |
| **Complexity** | Low |
| **Real-time** | No — polling-based. Could miss rapid device join/leave. |

**Considerations**:
- Practical for "batch-start coordination" — check who's active before a large upload
- Not suitable for continuous real-time stamping coordination
- Could work as a fallback when real-time channels are unavailable
- Each poll costs a Swarm read; each heartbeat costs a Swarm write + stamp slot

**Verdict**: Useful as a fallback or for batch-level coordination, but too slow for real-time stamp-by-stamp coordination.

---

### Option F: Hybrid — SOC Registration + Optimistic Locking

Instead of continuous real-time presence, use a coarser approach:

| Aspect | Details |
|--------|---------|
| **How** | When a device starts uploading, it writes a "lock" SOC to a known feed with a timestamp and a claimed slot range. Before uploading, devices check for active locks. After uploading, the lock is released. |
| **Coordination granularity** | Per-upload-batch, not per-stamp |
| **Collision window** | Between writing the lock and other devices reading it (seconds) |
| **Complexity** | Low-moderate |

**Considerations**:
- Works well if uploads are batched (debounced uploader already batches within 1s windows)
- Collision window is small: only during the race between lock-write and lock-check
- Could combine with interleaved slots: claim slot range in the lock SOC
- Deadlock risk if a device crashes while holding a lock (needs TTL-based expiry)

**Verdict**: Pragmatic for the common case. The collision window is small enough that data loss would be rare. Combined with interleaved slots, could be sufficient.

---

## Approaches NOT Recommended

| Approach | Why Not |
|----------|---------|
| **Static bucket partitioning** | Chunk addresses (and thus bucket assignment) are determined by content hash — cannot control which bucket a chunk lands in |
| **Gun.js** | Declining maintenance, reliability issues, poor documentation |
| **Matrix** | Overkill for lightweight coordination |
| **Full CRDT with total device count** | Static interleaving by all registered devices wastes too much capacity when most are idle |

---

## Comparative Summary

| Option | Real-Time | Infrastructure | Complexity | Decentralized | Works Today |
|--------|-----------|---------------|------------|---------------|-------------|
| **A: GSOC via Bee** | Yes | Full Bee node | Moderate | Partial | Yes (with full node) |
| **B: libp2p WebRTC** | Yes | Relay + STUN | High | Yes | Yes |
| **C: Nostr relay** | Near-RT | Public relays | Low-mod | Partial | Yes |
| **D: WebSocket server** | Yes | Hosted server | Low | No | Yes |
| **E: SOC polling** | No | None | Low | Yes | Yes |
| **F: SOC + optimistic lock** | Near-RT | None | Low-mod | Yes | Yes |

---

## Recommended Strategy

### Phase 1: SharedWorker (Same-Device)
Implement SharedWorker + BroadcastChannel for tab coordination. This is a standalone improvement with zero infrastructure requirements.

### Phase 2: Pick ONE Cross-Device Approach

The choice depends on the project's priorities:

- **If Swarm-native purity matters most**: Option A (GSOC) or Option F (SOC optimistic locking)
- **If practical decentralization matters**: Option C (Nostr) — low barrier, reasonable latency, no self-hosted infra
- **If libp2p exploration is a goal anyway**: Option B — most complex but provides a general P2P foundation
- **If "just make it work" for now**: Option D (WebSocket server) or Option F (SOC optimistic locking)

### Phase 3 (Future): In-Browser Bee Node
When the Swarm team ships the in-browser Bee light node, migrate to GSOC-based real-time presence. This is the long-term ideal: fully Swarm-native, no external dependencies.
