# Multi-Device SwarmID — Partition-Lease iteration 2 (P2): per-partition lock SOC

## Reframing

Iteration 1 (`Multi-Device-Partition-Lease-iteration-1.md`) ruled out a shared lock SOC because _"a shared lease SOC is racy and unsafe as a primary mechanism"_, and gave each device its own claim feed instead. In practice that design has three race conditions:

- **Race 1 — holder refreshes during takeover.** Taker reads holder's claim, sees it expired, writes its own. Holder's heartbeat fires between read and write and rewrites a fresh expiry on its _own_ feed. Each device's feed is independent, so neither write overwrites the other. Both believe they hold the same partition.
- **Race 2 — simultaneous takeovers.** Two would-be takers each see the same expired claim, each write their own takeover feed. No feed-level conflict because they write different feeds. Both believe they hold the partition until the next `activeDevices` snapshot sync.
- **Race 3 — `activeDevices` snapshot stomp.** Concurrent edits to the per-device partition assignment in the account snapshot last-write-wins on the entire snapshot blob.

This iteration takes the opposite stance: **a single shared SOC per partition can be made safe enough** if every write is followed by a guard interval and a verify-read, and concurrent writers are ordered by a deterministic fencing token. Under cooperative non-malicious devices with bounded Swarm propagation delay δ, all three races dissolve at the cost of one extra read on every claim or refresh.

## The atomicity primitive Swarm gives us

A SOC at `(owner, identifier)` has Last-Write-Wins semantics: every write replaces the previous chunk for that exact tuple, signed by `owner`. What it _lacks_ is linearizability — a write made at T₀ becomes visible to other readers at T₀ + δ, where δ is the gossip-plus-chunk-syncing propagation delay.

δ is observable. Measure it as the read-after-write latency in your deployment. On a single-node dev cluster it's typically < 100 ms. On the public Swarm network it's likely 1–5 s, sometimes more under load.

The protocol below pulls one lever: **after we write, we wait for δ to elapse and then re-read.** If our write is still the latest visible chunk, we know that no concurrent write made it first (any earlier write would have already propagated; any later write would have to wait and discover ours).

## Lock SOC location and payload

One SOC per partition, owned by `backupSigner` (already shared across devices via `deriveSecret(swarmEncryptionKey, "backup-key")` — same signer as the existing partition-claim and partition-state feeds). Identifier domain-separated from the existing iteration-1 feeds:

```
identifier = keccak256("swarm-id-partition-lock-v1:" ‖ accountId ‖ ":" ‖ partition)
owner       = backup signer (shared)
encryption  = swarmEncryptionKey (same as iteration-1 feeds)
```

Payload (~150 bytes JSON, well under the 4096-byte chunk limit):

```ts
{
  holderDeviceId: string // "" for explicit release
  generation: {
    timestampMs: number // wall-clock ms at write
    tiebreaker: string // 16-hex (8 bytes) of keccak256(deviceId)
  }
  acquiredAt: number // ms — when this lease started
  leasedUntil: number // ms — heartbeat-driven expiry
}
```

The lock SOC is the **single authoritative answer** to "who holds partition X". The iteration-1 per-device claim feeds become optional observability metadata (we may keep writing them for a while during the transition; readers ignore them).

## Protocol — acquire / takeover

```
Read  lock SOC at (backupSigner.address, makePartitionLockIdentifier(accountId, p))
Case 1: empty                                              → proceed to Write phase
Case 2: holder == me                                       → proceed to Write phase (refresh)
Case 3: holder != me, leasedUntil  > now                   → outcome = "blocked", return
Case 4: holder != me, leasedUntil <= now                   → proceed to Write phase (takeover)

Write phase:
  ourGen = { timestampMs: now(), tiebreaker: keccak256(deviceId)[0..8] }
  ourPayload = { holderDeviceId: me, generation: ourGen, acquiredAt: now(), leasedUntil: now()+TTL }
  writePartitionLock(ourPayload)

Wait δ.

Verify:
  Read  lock SOC
  cmp = compareGenerations(verified.generation, ourGen)
  if cmp >  0 → outcome = "lost-race"  (someone wrote a higher gen after us)
  if cmp == 0 → outcome = "acquired"   (our write is still latest)
  if cmp <  0 → outcome = "acquired"   (defensive; shouldn't happen)
```

Refresh is the same protocol — the precondition Case 2 means an existing holder simply re-runs the write+verify to extend its lease. The fencing token ensures monotonic progress even across browser reloads (the new generation timestamp is strictly greater than any prior one for the same device's writes).

## Fencing-token design

`generation = (timestampMs, tiebreaker)` compared lexicographically:

```ts
compareGenerations(a, b):
  if a.timestampMs !== b.timestampMs → a.timestampMs <=> b.timestampMs
  else                               → a.tiebreaker  <=> b.tiebreaker  // hex compare
```

`timestampMs` is `Date.now()`. Two devices can pick the same ms; the deviceId-derived `tiebreaker` decides deterministically and the same device always produces the same tiebreaker (so re-runs are idempotent in ordering).

Generation collision (same ms + same tiebreaker) would require either the same device writing twice in the same millisecond (we just check it monotonically advances) or a `keccak256(deviceId)` first-8-bytes collision between two different devices (2⁻⁶⁴ — effectively impossible for non-malicious devices).

## How each race dissolves

**Race 1 (holder refreshes during takeover).** Both holder H and taker T write the same lock SOC. Whoever's write is the latest visible after T's δ-wait holds the partition. The other reads the verify and learns they lost. Importantly, if H's refresh lands after T's write but before T's verify, T sees H's higher generation in the verify-read and aborts. The system never reaches a state where both think they hold the partition.

**Race 2 (simultaneous takeovers).** Takers B and C both write the lock SOC. Whichever wrote later (or had the higher tiebreaker at equal timestamps) ends up as the "latest" chunk after δ. Both verify-read after δ and converge on the same observed holder. The loser returns `"lost-race"` and treats itself as not holding the partition.

**Race 3 (`activeDevices` stomp).** The lock SOC is the source of truth — `activeDevices` is no longer needed for correctness. Snapshot drift becomes observability noise, not safety risk.

## Guard-time δ tuning

Pick `guardMs` ≥ the 99th-percentile read-after-write latency on the cluster. Recommended defaults:

- **Local dev / single-node cluster:** 500 ms.
- **Multi-node testnet:** 2 s.
- **Public Swarm:** 5 s, possibly 10 s under load.

Failure modes:

- **δ too short:** a concurrent writer's chunk hasn't propagated yet, you verify-read your own write, both devices believe they "acquired". Race re-enters by another mechanism (the next refresh).
- **δ too long:** acquire and refresh latencies grow linearly. Heartbeat interval must remain > 2 · δ + jitter to keep refreshes non-overlapping.

Practical tuning: ship a configurable default; expose a measurement helper (`measureSwarmRoundTripMs()`) so the app can recalibrate at start-up. Not in this iteration's scope — start with a 2 s default and revisit.

## Migration from iteration 1

Both designs coexist for a transition window:

- **Writers:** start writing the lock SOC in addition to the existing per-device claim feed. The lock SOC is the source of truth for any device aware of it; the claim feed is appended for backwards observability.
- **Readers:** prefer the lock SOC. Fall back to scanning per-device claim feeds only if the lock SOC has never been written (legacy account).
- **`activeDevices`:** keep populating it for the UI's Devices screen, but no code path consults it for correctness any more.

Eventually (post-validation, separate PR) drop the per-device claim feed writes entirely.

## Open questions

- **Counter publishing cadence.** Today `partition-state` is only published on `release()`. After this design lands, we should consider publishing partition counters as part of every Nth heartbeat so a takeover always has a fresh reseed baseline. Cost: an extra ~10 KB chunk per heartbeat. Worth it.
- **Should `activeDevices` be dropped from the account snapshot once readers stop consulting it?** Probably yes, but in a later cleanup PR — keeping it during transition lowers risk.
- **What if the entire backup signer is compromised?** Outside this iteration's threat model (cooperative non-malicious devices). The lock SOC has no defenses against a malicious device that has the shared signer key — but neither does iteration 1.
- **`measureSwarmRoundTripMs()` helper.** A future affordance to let the app self-tune `guardMs` based on the actual cluster behaviour, rather than ship a global default.

## Implementation scope (this iteration)

Build the lock primitive in isolation:

1. New module `lib/src/sync/partition-lock.ts` with `readPartitionLock`, `writePartitionLock`, `acquirePartitionLock`.
2. Unit/integration tests `lib/src/sync/partition-lock.test.ts` using `MockBee` + `mockFetch` — covers round-trip, single-device acquire, refresh, concurrent acquires, verify-after-write-catches-concurrent-override, blocked path doesn't write.
3. **No integration into `PartitionLease.acquire()` yet.** Wiring happens in a follow-up iteration once the lock primitive is verified.
