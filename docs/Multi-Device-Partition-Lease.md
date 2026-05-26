# Multi-Device SwarmID — Partition-Lease Proposal

## Context

GitHub issue [#217](https://github.com/snaha/swarm-id/issues/217) frames the user need as _"use SwarmID from multiple devices simultaneously."_ Account identity is already device-portable (same passkey + same PRF salt + epoch-feed snapshot in `lib/src/sync/`). The hard blocker is **postage-stamp bucket:slot collisions**: `UtilizationAwareStamper` (`lib/src/utils/batch-utilization.ts:1178-1198`) picks the next slot from an IndexedDB-local counter, so two devices can hand the same `(bucket, slot)` to different chunks. Mutable batches silently overwrite — _the second writer wipes the first's chunk_.

Constraints captured from the user:

- **Out of scope:** same-browser tab coordination — already handled by `BroadcastChannel("swarm-id-utilization")` (`lib/src/swarm-id-proxy.ts:164-165, 569-581`).
- **Up to 2 active devices simultaneously** (see _Usage shape_ below); many registered devices supported via explicit handover.
- **Zero new infrastructure.** No GSOC, no relay, no STUN, no Nostr.
- **Atomic-SOC is impossible.** A shared lock SOC is racy and unsafe as a primary mechanism.
- **Optimise for the steady state.** One device holds the lease for a long time and _extends_ it; adding a new device is rare relative to lease lifetime. Per-upload coordination cost must be effectively zero.
- Onboarding: QR or approval prompt acceptable.

Usage shape (confirmed with the user): **2 devices are the steady state** — phone + laptop, in either order. A 3rd device exists only via explicit handover from one of the active two. This caps _active_ devices at 2 while allowing many _registered_ devices in the account snapshot. The protocol below is optimised for this shape; the underlying mechanism (claim feeds + partition state feeds) generalises if the cap is later raised.

Direction: **lease a partition of the stamp space, track utilisation locally inside the partition, publish utilisation to a per-partition feed when the lease ends so the next leaser can resume**.

## Core mechanism

### Slot-space partitioning

For each of the 65,536 buckets, the per-bucket slot space is split into **K disjoint partitions**:

```
slots assigned to partition p  =  { p + K·j : j = 0, 1, 2, … }
```

Within a leased partition, the holder advances `j` strictly monotonically from a local counter. Two devices on different partitions cannot collide on `(bucket, slot)`.

`PARTITION_COUNT = 2` by default — one partition per active device, capped at 2 active devices. K is stored on the account snapshot for forward-compatibility and so all devices agree. It can be increased later (existing devices keep their partition; new IDs map into the new range) but never decreased while devices still depend on the higher indices. K=2 leaves plenty of per-device capacity across all useful batch depths:

| Batch depth | Slots / bucket | Slots/device at K=2 |
| ----------- | -------------- | ------------------- |
| 20          | 16             | 8                   |
| 22          | 64             | 32                  |
| 24          | 256            | 128                 |

### Active vs registered devices

The account snapshot's `devices: DeviceSchemaV1[]` (`lib/src/schemas.ts:112-116`, already in place) lists all _registered_ devices. A new field `activeDevices: { deviceId, partition }[]` (length ≤ `PARTITION_COUNT`) tracks the current partition holders. Registration is a prerequisite for becoming active; transitions in and out of active happen via the protocol below and update both fields atomically through the existing `lib/src/sync/sync-account.ts` snapshot rewrite. Many devices may be registered; at most `PARTITION_COUNT` (default 2) are active at any time.

### Per-device claim feed (the atomicity trick)

A _shared_ lease SOC is racy. The fix: never write to a SOC any other device might also write to. Instead, each device owns its own claim feed, whose signer is exactly that device — no concurrent-write race against itself.

```
topic  = H("swarm-id-device-claim-v1" ∥ accountId ∥ deviceId)
owner  = backup signer (same as account snapshot signer; already derived)
```

Latest entry is the device's current claim:

```ts
{
  partition: number,             // 0..K-1, or -1 = no claim
  leasedUntil: number,           // unix ms
  generation: number,            // monotonic per device, never decreases
  acquiredAt: number,
}
```

The set of current claims = union of every known device's latest claim entry. The known-devices list lives in the account snapshot (`lib/src/schemas.ts` `DeviceSchemaV1`); the currently-active subset is `activeDevices` (see _Active vs registered devices_ above).

Crucially, _because every device writes only to its own feed_, there is no shared object to race on at any time — not just during the steady-state hold. Partition assignment itself is determined by the snapshot's `activeDevices` (Cases A/B) or by user-approved handover (Case C/D), not by claim-feed contention. No probabilistic tiebreak required.

### Per-partition state feed

Each partition has a state feed (epoch — only the latest entry matters):

```
topic = H("swarm-id-partition-state-v1" ∥ batchId ∥ partition)
owner = backup signer
```

Payload (encrypted with `swarmEncryptionKey`): the partition's `bucketCounters: Uint32Array(65536)` plus `{ publishedBy: deviceId, publishedAt }`. About 256 KiB pre-encryption, chunked via existing Bee chunking.

This feed is **written by the holder only when releasing the lease**, and **read by the next holder when acquiring**. It is _not_ written periodically — the steady-state writer touches it zero times during a long session.

### Lifecycle protocol (optimised for long-lived single-holder leases)

**Acquire** runs eagerly on sign-in (cheap now that there is no race window to settle). Which sub-case applies is determined by reading the account snapshot's `activeDevices` and each known device's claim feed once at start.

**Case A — first device on a fresh account** (`activeDevices` empty or self-only):

1. Take partition 0. Write claim entry `{ partition: 0, leasedUntil: now + LEASE_TTL_MS, generation+1 }` to my claim feed.
2. Update snapshot: `activeDevices = [{ self, 0 }]`. No partition state feed read — partition 0 is fresh.

**Case B — second device on the same passkey** (exactly one _other_ device in `activeDevices`, one partition free):

1. Read the other device's claim feed; confirm `leasedUntil > now` for its partition `q`.
2. The free partition is `1 - q` (or, more generally, the single element of `{ 0..K-1 } \ { q }` when K=2). Read its partition state feed; seed local `bucketCounters` with the appropriate `RESUME_COUNTER_SKEW`.
3. Write my claim entry to my claim feed.
4. Update snapshot: append `{ self, freePartition }` to `activeDevices`.
5. Best-effort: append a `device-joined` event to the admission feed (see Onboarding) so the first device's UI surfaces _"A new device joined your account — Revoke?"_ The notification is non-blocking; the join itself does not require approval.

**Case C — third+ device** (both partitions held by other devices, all leases live):

1. New device prompts the user: _"You already have 2 active devices — [iPhone] and [MacBook]. Which one should this device replace?"_
2. New device writes a `handover-request` entry to the admission feed (`H(accountId ∥ "device-admissions-v1")`): `{ kind: "handover-request", requesterDeviceId, targetDeviceId, requestedAt, expiresAt = requestedAt + HANDOVER_REQUEST_TTL_MS }`.
3. The target device polls the admission feed at `ADMISSION_POLL_MS` (or the bumped `15 s` cadence when the user has the _Devices_ screen open) and shows: _"[iPad] wants to take over [MacBook]'s active slot — Approve / Reject."_
4. **On Approve:** target device publishes its current `bucketCounters` to its partition state feed, writes a release entry to its own claim feed (`partition: -1`), and writes a `handover-grant` to the admission feed carrying the partition number.
5. **On Reject:** target writes `handover-reject`; new device surfaces the rejection to the user and offers to retry against the other device.
6. New device polls the admission feed, sees the grant, reads the partition state feed (now freshly published), applies `RESUME_COUNTER_SKEW` defensively (the handover write may not yet have settled), takes the partition, and rewrites the snapshot's `activeDevices` to replace the displaced device's entry with its own.
7. If `HANDOVER_REQUEST_TTL_MS` elapses with no grant or reject (target offline or unresponsive), the request is treated as expired; the new device can retry against the other active device or fall through to Case D if either lease has since expired.

**Case D — crash recovery** (any partition's claim feed shows `leasedUntil < now`):

1. The reclaiming device displays: _"[MacBook] hasn't checked in for [LEASE_TTL_MS]. Take over its partition?"_
2. On user confirmation, proceed as in Case B's steps 2–4, using the _expired_ partition: read partition state feed (last published snapshot from the crashed device's prior session), apply `RESUME_COUNTER_SKEW`, take the partition, rewrite `activeDevices` replacing the crashed entry.
3. If the crashed device later comes back online, it reads the snapshot, sees its `deviceId` is no longer in `activeDevices`, and enters read-only mode. UI surfaces _"Your active slot was claimed by [iPad] — request handover to resume uploads."_

If the user in Case C picks a target whose lease has already expired, the new device silently falls back to Case D rather than waiting for a grant from a dead target.

The probabilistic claim-nonce tiebreak from the prior version of this doc is **deleted entirely**. Cases A and B are structurally race-free (no other contender); Case C is gated by user approval on the displaced device; Case D requires explicit user confirmation. There is no acquire-time settle wait, so subsequent uploads inherit zero coordination cost regardless of cold-start path.

**Hold** (the common case — the user explicitly asked us to optimise this):

- **Per upload: zero coordination.** Stamp using `(p + K · localCounter[bucket])`. Increment `localCounter[bucket]`. That's it. No network, no feed read, no feed write.
- **Lease refresh** every `LEASE_REFRESH_MS = LEASE_TTL_MS / 4`. Single feed write — append a refresh entry to my claim feed bumping `leasedUntil` and `generation`. Cheap and rare relative to upload throughput.
- **Background poll** of other devices' claim feeds on the same cadence as refresh (`LEASE_REFRESH_MS`). Just enough to notice when a new device has joined. _No action needed_ if the newcomer picked a different partition, which is the overwhelmingly common case.
- **No periodic partition-state checkpoint.** State stays in IndexedDB; we only commit it at release time.

With the recommended defaults (`LEASE_TTL_MS = 1 h`, `LEASE_REFRESH_MS = 15 min`), an 8-hour active session produces ~32 feed writes and ~32 feed reads total — independent of upload volume.

**Release** — only path that publishes partition state:

- Explicit: sign-out, account-switch, beforeunload (best-effort via the existing `BroadcastChannel` close handler), or as the _Approve_ step of a Case C handover.
  1. Publish current `bucketCounters` to the partition state feed.
  2. Write a release entry (`partition: -1`) to my claim feed.
  3. For Case C only: additionally write a `handover-grant` event to the admission feed so the requester knows the partition state feed is now fresh.
- TTL-expiry (the holder crashed or vanished without releasing):
  - Other devices observe `leasedUntil < now` on next poll. The partition becomes eligible for reclaim via Case D (Crash recovery). The next leaser reads the partition state feed — which holds _the last published snapshot_ (from the previous explicit release, possibly some time ago). Slot indices used by the crashed device since its last release may be re-used. **This is the only correctness gap and it is bounded** — see "Crash bound" below.

### Crash bound and remediation

The only failure mode left is: device A holds partition `p`, crashes mid-session without publishing state, device B later acquires `p` and re-uses some slots A had already claimed.

Bound: the lost-slot count for partition `p` equals "slots A stamped in this session, since A's last explicit release of `p`." This typically caps at the _previous_ session's slot count — at most a few hundred to a few thousand slots per crash.

Mitigations layered on top, in order of effort:

1. **Skew local counters on resume.** When acquiring a partition, after seeding from the state feed, _add a safety skew_ (e.g. `+ ceil(slotsPerBucket / K / 4)`) to every counter. Skips a small slot range that the previous holder _might_ have used. Cheap. Eliminates most of the residual collision risk at the cost of a small permanent capacity loss per crash.
2. **Optional post-hoc reconciler (Phase 3).** Periodically scan recent uploads and re-stamp anything whose stored stamp signer doesn't match the expected one. Pure safety net; not on the hot path.

Periodic state checkpoints were considered and rejected on the user's instruction to optimise the common case — they'd cost ~64 chunks (~256 KiB) per checkpoint just to handle a rare crash scenario.

## Onboarding

Onboarding now collapses into the Acquire cases above; the admission feed exists primarily as the channel for handover/revoke events, not as a hard gate.

- **Same-passkey flow.** Sign-in derives the same master key. The new device appends itself to the snapshot's `devices` array and runs Acquire. If `activeDevices` has a free slot this is Case A or B and completes silently. If both slots are taken it is Case C and the user is prompted to pick a device to replace.

- **QR pairing.** Still useful when the new device cannot rely on feed-based handover within a reasonable window (e.g., a freshly-installed browser profile with no shared storage and offline existing devices). Source device renders a QR carrying a short-lived claim code plus a Swarm reference to the encrypted `.swarmid` snapshot (`lib/src/utils/backup-encryption.ts`). The new device scans, decrypts, registers itself, and either auto-admits in Case A (cold start with no other device) or pairs straight into Case B if exactly one device is currently active. Case C still applies if two devices are already active — QR pairing does not bypass the displaced-device approval.

Admission-feed poll cadence: lazy at `ADMISSION_POLL_MS` by default, bumped to a tighter `15 s` while the user has the _Devices_ screen open or a handover request in flight. The same poll surfaces revocations (Case B notification → user clicks Revoke) and `device-joined` events.

## Live awareness (optional, Phase 2)

Once devices already poll each other's claim feeds at the slow cadence, the same poll can surface "MacBook is active" indicators in the UI driven by `acquiredAt` / `leasedUntil`. No additional feed traffic. A separate, finer-grained activity feed (per-device, append-only) can be added later if the user wants real-time _"MacBook uploaded a file 4 s ago"_ — but this is purely cosmetic.

## Configurable knobs (proposed defaults, all SCREAMING_SNAKE_CASE constants)

| Constant                  | Default                                      | Comment                                                                                                                                    |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PARTITION_COUNT`         | `2`                                          | Hard default — one partition per active device, capped at 2 active devices. Raising it is a future opt-in; stored on the account snapshot. |
| `LEASE_TTL_MS`            | `3_600_000`                                  | 1 hour — long, matching the "rarely contested" steady state.                                                                               |
| `LEASE_REFRESH_MS`        | `900_000`                                    | TTL / 4 = 15 min — single feed write per interval.                                                                                         |
| `ADMISSION_POLL_MS`       | `900_000`                                    | Lazy by default; bumped to `15_000` while the _Devices_ screen is open or a handover request is in flight.                                 |
| `HANDOVER_REQUEST_TTL_MS` | `300_000`                                    | 5 min. A handover request expires if not approved/rejected; new device can retry against the other active device or fall back to Case D.   |
| `RESUME_COUNTER_SKEW`     | `ceil(slotsPerBucket / PARTITION_COUNT / 4)` | Defensive bump when seeding from a state feed (whether via planned handover or crash recovery).                                            |

## Cost summary (the optimisation the user asked for)

Single device, 8-hour session, 10,000 uploads:

| Action                         | Count   | Network cost                                                                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Stamping                       | 10,000  | 0 (pure local)                                                                                                     |
| Lease refresh                  | 32      | 32 small feed writes                                                                                               |
| Background poll                | 32      | 32 feed reads × N_active_devices                                                                                   |
| Cold-start acquire — Case A    | 1       | 1 claim write + 1 snapshot rewrite                                                                                 |
| Cold-start acquire — Case B    | 1       | 1 other-device claim read + 1 state feed read + 1 claim write + 1 snapshot rewrite + 1 best-effort admission write |
| Cold-start acquire — Case C    | 1       | 1 admission write + admission polling (already counted) + 1 state feed read + 1 snapshot rewrite (after grant)     |
| Release on sign-out            | 1       | 1 state feed write (~64 chunks) + 1 claim release                                                                  |
| **Total feed writes (Case A)** | **~34** |                                                                                                                    |
| **Coordination per upload**    | **0**   | unchanged from prior design                                                                                        |

Two-device session of the same length adds the second device's own refresh/poll budget; the two are independent because their partitions are disjoint. Case C is paid only when a 3rd device joins — by construction a rare, user-driven event.

## Alternatives considered & rejected

- **Symmetric N-device with race-based acquire (the previous version of this doc).** Generalises to any number of active devices without explicit handover, at the cost of an acquire-time settle wait and claim-nonce tiebreak. The user confirmed that 2 active devices match the real usage shape, so the simpler 2-active model with explicit handover for the 3rd is preferred. Superseded.
- **Hard cap > 2 active devices.** Possible by raising `PARTITION_COUNT`, but each additional partition further fragments per-bucket capacity and the user did not ask for it. Left as a future opt-in (the snapshot already carries `partitionCount` for forward-compatibility).
- **Approval-gated 2nd device join.** Would require the 1st device to Approve before the 2nd can write. Rejected per user direction: the 2nd device auto-grants and the 1st gets a non-blocking _"new device joined — Revoke?"_ notification instead.
- **Single shared lease SOC** — user-rejected; SOC isn't atomic.
- **Static partition by `H(deviceId) mod K`** — no coordination ever, but capacity is permanently wasted on registered-but-idle devices and partitions can't be recycled.
- **Periodic partition-state checkpoint** — would safeguard against crash slot-reuse, but costs ~64 chunks per checkpoint. User asked us to optimise the common case, and the steady state has no checkpoints to amortise. Replaced by `RESUME_COUNTER_SKEW` plus optional Phase 3 reconciler.
- **Optimistic stamp + post-hoc detect** — kept as the optional Phase 3 safety net underneath partition-lease; not a primary mechanism.
- **Per-device postage batches** — eliminates collisions trivially but multiplies stamp cost by N. Worth offering as an opt-in "premium" mode, not the default.
- **GSOC / WebRTC / Nostr / WebSocket relay** — ruled out by zero-infra constraint.

## Critical files to touch

- **New** `lib/src/sync/partition-lease.ts` — implements Acquire Cases A–D, Hold, Refresh, Release. No claim-nonce tiebreak code; the race is eliminated structurally.
- **New** `lib/src/sync/partition-state.ts` — read/write per-partition counter snapshot to its epoch feed; apply `RESUME_COUNTER_SKEW` on read (whether the seed came from a planned handover or a crashed lease).
- **New** `lib/src/sync/device-admissions.ts` — carries `kind: "device-joined" | "handover-request" | "handover-grant" | "handover-reject" | "revoke"` events. Single feed at `H(accountId ∥ "device-admissions-v1")`; encrypted payload reusing `swarmEncryptionKey`.
- `lib/src/utils/batch-utilization.ts` (`stamp()` at `1159-1167`) — becomes partition-aware: slot = `partition + K · localCounter[bucket]`; counter state seeded from `partition-state.ts` at lease acquire.
- `lib/src/swarm-id-proxy.ts` (around `66-70`, `150-165`, `271-410`) — lifecycle: eager Acquire on sign-in (Cases A/B/C/D dispatch); refresh on a single timer; release on `beforeunload`/sign-out; surface lease state and Case-C/B UI signals in proxy messages.
- `lib/src/schemas.ts` — extend `CommonAccountSchemaV1` (around `105-132`) with `activeDevices: { deviceId: string, partition: number }[]` (default `[]`) and `partitionCount: number` (default `2`). Add `PartitionClaimSchemaV1`, `PartitionStateSchemaV1`, `AdmissionEventSchemaV1` (the discriminated union over `kind`).
- `lib/src/utils/device-id.ts` — already produces stable `deviceId` via localStorage (`18-25`); keep unchanged.
- `lib/src/utils/backup-encryption.ts` — reuse `swarmEncryptionKey` for claim/state/admission payload encryption. No new key material.
- `lib/src/sync/sync-account.ts`, `lib/src/sync/restore-account.ts` — snapshot round-trip already lists `devices`; extend to read/write `activeDevices` and `partitionCount` atomically with the rest of the snapshot.
- `swarm-ui/src/lib/stores/session.svelte.ts` (around `67-74`, `112-114`) — expose `currentPartition`, `isReadOnly`, `activeDevices`, and outbound signals for _new-device-joined_ notification, _handover-request_ modal, and _your slot was claimed_ banner.
- `swarm-ui/src/routes/` — three new UI surfaces:
  1. _"Replace which device?"_ picker rendered on the joining device when Case C triggers.
  2. _"Approve handover?"_ modal on the displaced device, driven by admission-feed polling.
  3. _"A new device joined — Revoke?"_ non-blocking notification on the 1st device after Case B.
     Plus the QR pairing screen reusing existing backup-export plumbing.

## Verification plan

Concrete end-to-end checks. None require a Bee full node — the default gateway (`DEFAULT_BEE_NODE_URL` in `lib/src/schemas.ts:106`) suffices.

1. **Two-device collision test (the original bug).** Two browser profiles (Chromium + Firefox), same passkey. Each runs 100 uploads with 1–5 s gaps over several minutes. Assert: every `(bucket, slot)` pair is unique across both devices. Playwright e2e in `swarm-ui/tests/`.

2. **Steady-state cost.** Single device, 10,000 uploads over 8 hours (simulated clock). Assert: ≤ 40 claim-feed writes, ≤ 1 partition-state write, no per-upload network calls in the stamp path.

3. **Case C handover round-trip.** Two browser profiles already active (partitions 0 and 1). Open a third profile, pick _MacBook_ (profile 2) to displace. Assert: profile 2 receives the _Approve handover_ modal within `ADMISSION_POLL_MS`; on Approve, profile 2 publishes its partition state feed and writes a release; profile 3 acquires partition 1 with `RESUME_COUNTER_SKEW`; profile 2 enters read-only with the _"your slot was claimed"_ message. Run the same flow ending in Reject and assert profile 3 stays read-only.

4. **Case D crash recovery.** Device A holds partition 1, uploads, is killed before release. Device B advances mock clock past `LEASE_TTL_MS`, confirms the _take over_ prompt, acquires partition 1, seeds counters from state feed with `RESUME_COUNTER_SKEW`. Assert no real slot overlap on next 100 uploads. When device A comes back, assert it enters read-only with the correct messaging.

5. **Case B auto-grant + notification.** Sign in on profile B with the same passkey while profile A is active on partition 0. Assert: B auto-acquires partition 1 with no modal; A surfaces the _"new device joined"_ notification within one `LEASE_REFRESH_MS` cycle (or via storage event when same-browser). On clicking Revoke, B drops to read-only within one admission-poll cycle and the snapshot's `activeDevices` no longer lists B.

6. **Capacity boundary (Case C with displaced-device offline).** With `PARTITION_COUNT = 2`, two devices active. A 3rd device requests handover from a target that is currently offline. Assert: the request expires after `HANDOVER_REQUEST_TTL_MS` and the 3rd device offers to retry against the other active device or take over the offline one via Case D (if its lease has now expired).

7. **Partition-state encoding round-trip.** Round-trip `PartitionStateSchemaV1` for a fully-utilised batch (all 65,536 counters > 0). Verify encrypted, chunked payload + decode is identical.

## Phased rollout

- **Phase 1 (correctness):** partition-lease (Cases A/B/D) + per-partition state + `device-joined`/`revoke` admission events. `PARTITION_COUNT = 2` hard default. Behind a `multiDevice` feature flag in `swarm-ui/`. Case C (handover) can ship in Phase 1 if 3rd-device usage is expected at launch; otherwise defer with a clear _"already have 2 active devices"_ read-only message.
- **Phase 2 (UX):** Case C handover end-to-end if not in Phase 1, _"Active on MacBook"_ banners (using already-polled claim feeds), queued-upload indicator, QR pairing screen, polish on the Case B notification and Case C / D modals.
- **Phase 3 (optional safety net):** post-hoc collision reconciler — periodically scan recent uploads and re-stamp anything whose stamped signer doesn't match the partition holder. Pure safety; not on the hot path. Removes the residual crash-recovery gap entirely.

Phase 1 alone fixes the issue. Phases 2-3 are quality-of-life improvements.

## Open questions

- **Revoke flow timing.** If the user clicks Revoke in the Case B _"new device joined"_ notification, does the just-joined device get kicked back to read-only immediately, or only on its next admission-feed poll? Recommendation: the revoking device writes a `revoke` event and the new device polls for it; if the new device misses the poll window (offline, etc.), the snapshot's `activeDevices` becomes the source of truth on next sync. Net latency ≤ `ADMISSION_POLL_MS`.
- **Handover target that is itself crashed.** If the user in Case C picks a target whose lease has already expired, the new device silently falls back to Case D (no need to ping a dead target). Confirmed in this doc; flagged here as the only "two cases overlap" edge worth implementing explicitly.
- **Skew-on-resume vs. Phase 3 reconciler.** Skew is cheap and conservative but permanently loses a sliver of capacity per crash or handover. Reconciler recovers everything but is more code. Ship both: skew in Phase 1, reconciler in Phase 3.
- **In-flight queued uploads while in read-only.** Queue in IndexedDB and flush once a partition is acquired. Confirm UX: do we surface the queue prominently, or keep it implicit until the partition is held?
- **Future: > 2 active devices.** `PARTITION_COUNT` lives in the snapshot, so raising it later is mechanically possible. The Case C handover prompt would need to support "pick from N targets" instead of always 2, and the cost summary should be re-derived. Not on the roadmap.

## Sources

- [Postage Stamps — Swarm Documentation](https://docs.ethswarm.org/docs/concepts/incentives/postage-stamps/) — confirms mutable-batch overwrite semantics (the silent-data-loss failure mode this proposal eliminates).
- [Web Locks API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) — the same-browser primitive already in use; included for completeness.
- [Signal — A Synchronized Start for Linked Devices](https://signal.org/blog/a-synchronized-start-for-linked-devices/) — QR-pairing pattern for the cold-start onboarding flow.
- [WebAuthn PRF extension (2026 status) — Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn) — cross-device PRF reproducibility, the basis for "same passkey, same identity."
- [DKMS framework — WebOfTrustInfo](https://github.com/WebOfTrustInfo/rwot4-paris/blob/master/topics-and-advance-readings/dkms-decentralized-key-mgmt-system.md) — background on decentralised-identity key handoff patterns.
- `docs/Multi-Device-Stamp-Coordination-Research.md` (in-repo) — prior internal survey. This proposal supersedes its "Approach 2" by switching from real-time presence (which required GSOC or external infra) to lease-based partitioning with release-time state publication.
