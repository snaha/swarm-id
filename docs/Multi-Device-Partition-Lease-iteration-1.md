# Multi-Device SwarmID — Partition-Lease Proposal

## Context

GitHub issue [#217](https://github.com/snaha/swarm-id/issues/217) frames the user need as *"use SwarmID from multiple devices simultaneously."* Account identity is already device-portable (same passkey + same PRF salt + epoch-feed snapshot in `lib/src/sync/`). The hard blocker is **postage-stamp bucket:slot collisions**: `UtilizationAwareStamper` (`lib/src/utils/batch-utilization.ts:1178-1198`) picks the next slot from an IndexedDB-local counter, so two devices can hand the same `(bucket, slot)` to different chunks. Mutable batches silently overwrite — *the second writer wipes the first's chunk*.

Constraints captured from the user:

- **Out of scope:** same-browser tab coordination — already handled by `BroadcastChannel("swarm-id-utilization")` (`lib/src/swarm-id-proxy.ts:164-165, 569-581`).
- **Any number of devices,** usually sequential, overlap *may* happen.
- **Zero new infrastructure.** No GSOC, no relay, no STUN, no Nostr.
- **Atomic-SOC is impossible.** A shared lock SOC is racy and unsafe as a primary mechanism.
- **Optimise for the steady state.** One device holds the lease for a long time and *extends* it; adding a new device is rare relative to lease lifetime. Per-upload coordination cost must be effectively zero.
- Onboarding: QR or approval prompt acceptable.

Direction: **lease a partition of the stamp space, track utilisation locally inside the partition, publish utilisation to a per-partition feed when the lease ends so the next leaser can resume**.

## Core mechanism

### Slot-space partitioning

For each of the 65,536 buckets, the per-bucket slot space is split into **K disjoint partitions**:

```
slots assigned to partition p  =  { p + K·j : j = 0, 1, 2, … }
```

Within a leased partition, the holder advances `j` strictly monotonically from a local counter. Two devices on different partitions cannot collide on `(bucket, slot)`.

Trade-off: K caps both the number of simultaneous writers and the per-device share of bucket capacity.

| Batch depth | Slots / bucket | Slots/device at K=4 | Slots/device at K=8 | Slots/device at K=16 |
|-------------|----------------|----------------------|----------------------|-----------------------|
| 20          | 16             | 4                    | 2                    | 1                     |
| 22          | 64             | 16                   | 8                    | 4                     |
| 24          | 256            | 64                   | 32                   | 16                    |

K is stored on the account snapshot so all devices agree. Proposed default `K = max(2, min(16, slotsPerBucket / 4))` — auto-derived from the batch depth. K can be increased later (existing devices keep their partition; new IDs map into the new range), but never decreased while devices still depend on the higher indices.

### Per-device claim feed (the atomicity trick)

A *shared* lease SOC is racy. The fix: never write to a SOC any other device might also write to. Instead, each device owns its own claim feed, whose signer is exactly that device — no concurrent-write race against itself.

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
  claimNonce: Bytes(8),          // random per claim, used only for tiebreak
}
```

The set of current claims = union of every known device's latest claim entry. The known-devices list lives in the account snapshot (`lib/src/schemas.ts` `DeviceSchemaV1`).

Crucially, *because the steady-state holder writes only to its own feed, there is no shared object to race on while the lease is held*. The race window exists only at acquire time, when two devices might simultaneously decide a partition is free.

### Per-partition state feed

Each partition has a state feed (epoch — only the latest entry matters):

```
topic = H("swarm-id-partition-state-v1" ∥ batchId ∥ partition)
owner = backup signer
```

Payload (encrypted with `swarmEncryptionKey`): the partition's `bucketCounters: Uint32Array(65536)` plus `{ publishedBy: deviceId, publishedAt }`. About 256 KiB pre-encryption, chunked via existing Bee chunking.

This feed is **written by the holder only when releasing the lease**, and **read by the next holder when acquiring**. It is *not* written periodically — the steady-state writer touches it zero times during a long session.

### Lifecycle protocol (optimised for long-lived single-holder leases)

**Acquire** — runs once per session, on first upload attempt (or eagerly on sign-in if you want the UI to show partition state immediately):

1. Read each known device's claim feed in parallel.
2. Compute `freePartitions = { 0..K-1 } \ { p : some device's leasedUntil > now ∧ that device's deviceId ≠ self }`.
3. If `freePartitions` empty → **read-only mode**; surface *"All slots are in use — wait for a device to disconnect."* Background-retry every `WAIT_RECHECK_MS`.
4. Pick partition `p` (lowest-numbered free, deterministic tiebreak).
5. Write claim `{ partition: p, leasedUntil: now + LEASE_TTL_MS, generation+1, claimNonce: random(8 bytes) }` to **my** claim feed.
6. Wait `CLAIM_SETTLE_MS` for the write to propagate.
7. Re-read all claim feeds. If another device's latest entry also claims `p` with `acquiredAt` within `2·CLAIM_SETTLE_MS`: tiebreak by lower `claimNonce`. Loser writes a release (`partition: -1`) and goes to step 2.
8. Winner reads partition `p`'s state feed and seeds local `bucketCounters`. Lease is held.

Steps 6-8 only run on cold-start of a session. Subsequent uploads pay none of this cost.

**Hold** (the common case — the user explicitly asked us to optimise this):

- **Per upload: zero coordination.** Stamp using `(p + K · localCounter[bucket])`. Increment `localCounter[bucket]`. That's it. No network, no feed read, no feed write.
- **Lease refresh** every `LEASE_REFRESH_MS = LEASE_TTL_MS / 4`. Single feed write — append a refresh entry to my claim feed bumping `leasedUntil` and `generation`. Cheap and rare relative to upload throughput.
- **Background poll** of other devices' claim feeds on the same cadence as refresh (`LEASE_REFRESH_MS`). Just enough to notice when a new device has joined. *No action needed* if the newcomer picked a different partition, which is the overwhelmingly common case.
- **No periodic partition-state checkpoint.** State stays in IndexedDB; we only commit it at release time.

With the recommended defaults (`LEASE_TTL_MS = 1 h`, `LEASE_REFRESH_MS = 15 min`), an 8-hour active session produces ~32 feed writes and ~32 feed reads total — independent of upload volume.

**Release** — only path that publishes partition state:

- Explicit: sign-out, account-switch, beforeunload (best-effort via the existing `BroadcastChannel` close handler).
  1. Publish current `bucketCounters` to the partition state feed.
  2. Write a release entry (`partition: -1`) to my claim feed.
- TTL-expiry (the holder crashed or vanished without releasing):
  - Other devices observe `leasedUntil < now` on next poll. The partition becomes free. The next leaser reads the partition state feed — which holds *the last published snapshot* (from the previous explicit release, possibly some time ago). Slot indices used by the crashed device since its last release may be re-used. **This is the only correctness gap and it is bounded** — see "Crash bound" below.

### Crash bound and remediation

The only failure mode left is: device A holds partition `p`, crashes mid-session without publishing state, device B later acquires `p` and re-uses some slots A had already claimed.

Bound: the lost-slot count for partition `p` equals "slots A stamped in this session, since A's last explicit release of `p`." This typically caps at the *previous* session's slot count — at most a few hundred to a few thousand slots per crash.

Mitigations layered on top, in order of effort:

1. **Skew local counters on resume.** When acquiring a partition, after seeding from the state feed, *add a safety skew* (e.g. `+ ceil(slotsPerBucket / K / 4)`) to every counter. Skips a small slot range that the previous holder *might* have used. Cheap. Eliminates most of the residual collision risk at the cost of a small permanent capacity loss per crash.
2. **Optional post-hoc reconciler (Phase 3).** Periodically scan recent uploads and re-stamp anything whose stored stamp signer doesn't match the expected one. Pure safety net; not on the hot path.

Periodic state checkpoints were considered and rejected on the user's instruction to optimise the common case — they'd cost ~64 chunks (~256 KiB) per checkpoint just to handle a rare crash scenario.

## Onboarding (rare event by definition)

Two flows, user picks per device:

- **Same-passkey on a new device + admission prompt.** Sign-in already derives the same master key. After first sign-in the new device writes a **device-admission request** to a feed at `H(accountId ∥ "device-admissions-v1")`. Already-signed-in devices show an in-app modal: *"Chrome on Linux wants to join your account — Approve / Reject."* Approval appends the device to the snapshot's `devices` array. Until approved the new device cannot claim a partition. This is the default UX.

- **QR pairing as cold-start** for the case where no other device is online. Source device renders a QR containing a 5-minute claim code + a Swarm reference to the existing encrypted `.swarmid` snapshot (already implemented in `lib/src/utils/backup-encryption.ts`). The new device scans, decrypts, registers itself, and either auto-admits (cold start with no prior device) or queues an admission request.

Because admission is rare relative to lease lifetime, the admission feed can be polled at the same lazy cadence as claim feeds (`LEASE_REFRESH_MS = 15 min`). When the user actively triggers a new-device join, the source device can also bump its poll frequency briefly (e.g. for 60 s after the user opens the "Add device" screen).

## Live awareness (optional, Phase 2)

Once devices already poll each other's claim feeds at the slow cadence, the same poll can surface "MacBook is active" indicators in the UI driven by `acquiredAt` / `leasedUntil`. No additional feed traffic. A separate, finer-grained activity feed (per-device, append-only) can be added later if the user wants real-time *"MacBook uploaded a file 4 s ago"* — but this is purely cosmetic.

## Configurable knobs (proposed defaults, all SCREAMING_SNAKE_CASE constants)

| Constant                  | Default     | Comment                                                                                |
|---------------------------|-------------|----------------------------------------------------------------------------------------|
| `PARTITION_COUNT`         | auto        | `max(2, min(16, slotsPerBucket / 4))`, stored on the account snapshot.                |
| `LEASE_TTL_MS`            | `3_600_000` | 1 hour — long, matching the "rarely contested" steady state.                          |
| `LEASE_REFRESH_MS`        | `900_000`   | TTL / 4 = 15 min — single feed write per interval.                                    |
| `CLAIM_SETTLE_MS`         | `3_000`     | Cold-start tiebreak window only; not paid on subsequent uploads.                       |
| `WAIT_RECHECK_MS`         | `30_000`    | When all partitions are leased, how often the queued device retries.                  |
| `ADMISSION_POLL_MS`       | `900_000`   | Lazy by default; bumped to `15_000` for 60 s when "Add device" is active.             |
| `RESUME_COUNTER_SKEW`     | `ceil(slotsPerBucket / PARTITION_COUNT / 4)` | Defensive bump when seeding from state feed after possible crash.            |

## Cost summary (the optimisation the user asked for)

Single device, 8-hour session, 10,000 uploads:

| Action                          | Count                            | Network cost                       |
|---------------------------------|----------------------------------|------------------------------------|
| Stamping                        | 10,000                           | 0 (pure local)                     |
| Lease refresh                   | 32                               | 32 small feed writes               |
| Background poll                 | 32                               | 32 feed reads × N_devices          |
| Cold-start acquire              | 1                                | 2 reads + 1 write + 1 settle wait  |
| Release on sign-out             | 1                                | 1 state feed write (~64 chunks)    |
| **Total feed writes**           | **~34**                          |                                    |
| **Total feed reads**            | **~33 × N_devices**              |                                    |
| **Coordination per upload**     | **0**                            |                                    |

Two-device session of the same length adds one acquire-time interaction and the second device's own refresh/poll budget; the two are independent because their partitions are disjoint.

## Alternatives considered & rejected

- **Single shared lease SOC** — user-rejected; SOC isn't atomic.
- **Static partition by `H(deviceId) mod K`** — no coordination ever, but capacity is permanently wasted on registered-but-idle devices and partitions can't be recycled.
- **Periodic partition-state checkpoint** — would safeguard against crash slot-reuse, but costs ~64 chunks per checkpoint. User asked us to optimise the common case, and the steady state has no checkpoints to amortise. Replaced by `RESUME_COUNTER_SKEW` plus optional Phase 3 reconciler.
- **Optimistic stamp + post-hoc detect** — kept as the optional Phase 3 safety net underneath partition-lease; not a primary mechanism.
- **Per-device postage batches** — eliminates collisions trivially but multiplies stamp cost by N. Worth offering as an opt-in "premium" mode, not the default.
- **GSOC / WebRTC / Nostr / WebSocket relay** — ruled out by zero-infra constraint.

## Critical files to touch

- **New** `lib/src/sync/partition-lease.ts` — acquire/hold/refresh/release; claim-feed read/write; tiebreak.
- **New** `lib/src/sync/partition-state.ts` — read/write per-partition counter snapshot to its epoch feed; apply `RESUME_COUNTER_SKEW` on read.
- **New** `lib/src/sync/device-admissions.ts` — admission request/approval/revocation.
- `lib/src/utils/batch-utilization.ts` (around `1178-1198`) — `stamp()` becomes partition-aware: slot = `partition + K · localCounter[bucket]`; counter state seeded from `partition-state.ts` at lease acquire.
- `lib/src/swarm-id-proxy.ts` (around `66-70`, `150-165`, `271-410`) — lifecycle: acquire on first upload (lazy) or sign-in (eager, configurable); refresh on a single timer; release on `beforeunload`/sign-out; surface lease state in proxy messages for the UI.
- `lib/src/schemas.ts` — new `PartitionClaimSchemaV1`, `PartitionStateSchemaV1`, `DeviceAdmissionRequestSchemaV1`; extend the account snapshot with `partitionCount: number`.
- `lib/src/utils/device-id.ts` — already produces stable `deviceId`; keep.
- `lib/src/utils/backup-encryption.ts` — reuse `swarmEncryptionKey` for claim/state/admission payload encryption. No new key material.
- `lib/src/sync/sync-account.ts`, `lib/src/sync/restore-account.ts` — extend the snapshot to carry admission metadata (`admittedAt`, `admittedBy`).
- `swarm-ui/src/lib/stores/session.svelte.ts` (around `67-74`, `112-114`) — expose `leaseHolder`, `currentPartition`, `isReadOnly`, `otherActiveDevices`.
- `swarm-ui/src/routes/` — admission-prompt modal triggered by entries on `device-admissions-v1`; "Another device is active" banner driven by lease state; QR pairing screen reusing existing backup-export plumbing.

## Verification plan

Concrete end-to-end checks. None require a Bee full node — the default gateway (`DEFAULT_BEE_NODE_URL` in `lib/src/schemas.ts:106`) suffices.

1. **Two-device collision test (the original bug).** Two browser profiles (Chromium + Firefox), same passkey. Each runs 100 uploads with 1–5 s gaps over several minutes. Assert: every `(bucket, slot)` pair is unique across both devices. Playwright e2e in `swarm-ui/tests/`.

2. **Steady-state cost.** Single device, 10,000 uploads over 8 hours (simulated clock). Assert: ≤ 40 claim-feed writes, ≤ 1 partition-state write, no per-upload network calls in the stamp path.

3. **Cold-start tiebreak.** Mock-clock test in `lib/src/sync/partition-lease.test.ts`: schedule two `acquire()` calls within 100 ms targeting the same partition, only one free partition available. Assert exactly one wins; the other backs off and acquires a different partition (or enters read-only if `K = 1` in the test fixture).

4. **Crash recovery.** Device A holds partition 3, uploads, gets killed before release. Device B waits past `LEASE_TTL_MS`, acquires partition 3, seeds counters from state feed with `RESUME_COUNTER_SKEW`. Assert no real slot overlap on next 100 uploads.

5. **Admission flow.** New device signs in with same passkey, writes admission request. Already-signed-in device shows modal within `ADMISSION_POLL_MS` (or within ~15 s if the user has the "Add device" screen open). Approve → new device's `partition` transitions from `-1` to a valid value. Reject → new device stays read-only.

6. **Capacity boundary.** With `K = 2`, launch 3 devices. The third stays read-only with a clear UI message. Releasing one of the first two unblocks the third.

7. **Partition-state encoding round-trip.** Round-trip `PartitionStateSchemaV1` for a fully-utilised batch (all 65,536 counters > 0). Verify encrypted, chunked payload + decode is identical.

## Phased rollout

- **Phase 1 (correctness):** partition-lease + per-partition state + admission gating. Auto-derive `PARTITION_COUNT`. Behind a `multiDevice` feature flag in `swarm-ui/`.
- **Phase 2 (UX):** *"Active on MacBook"* banners (using already-polled claim feeds), queued-upload indicator, QR pairing screen, admission modal polish.
- **Phase 3 (optional safety net):** post-hoc collision reconciler — periodically scan recent uploads and re-stamp anything whose stamped signer doesn't match the partition holder. Pure safety; not on the hot path. Removes the residual crash-recovery gap entirely.

Phase 1 alone fixes the issue. Phases 2-3 are quality-of-life improvements.

## Open questions

- **Eager vs lazy acquire on sign-in.** Eager pays the acquire cost up front (~3 s); lazy hides it but the first upload latency is visibly higher. Recommendation: eager when the UI shows an upload affordance, lazy otherwise. Configurable.
- **Skew-on-resume vs. Phase 3 reconciler.** Skew is cheap and conservative but permanently loses a sliver of capacity per crash. Reconciler recovers everything but is more code. Ship both: skew in Phase 1, reconciler in Phase 3.
- **Approval threshold.** Should admission require approval from *any* existing device, or a quorum (2 of N) for higher-stakes accounts? Default: any. Quorum is a future option.
- **In-flight queued uploads when the device is in read-only.** Queue in IndexedDB and flush once a partition is acquired. Confirm UX: do we surface the queue, or just keep it implicit?

## Sources

- [Postage Stamps — Swarm Documentation](https://docs.ethswarm.org/docs/concepts/incentives/postage-stamps/) — confirms mutable-batch overwrite semantics (the silent-data-loss failure mode this proposal eliminates).
- [Web Locks API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) — the same-browser primitive already in use; included for completeness.
- [Signal — A Synchronized Start for Linked Devices](https://signal.org/blog/a-synchronized-start-for-linked-devices/) — QR-pairing pattern for the cold-start onboarding flow.
- [WebAuthn PRF extension (2026 status) — Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn) — cross-device PRF reproducibility, the basis for "same passkey, same identity."
- [DKMS framework — WebOfTrustInfo](https://github.com/WebOfTrustInfo/rwot4-paris/blob/master/topics-and-advance-readings/dkms-decentralized-key-mgmt-system.md) — background on decentralised-identity key handoff patterns.
- `docs/Multi-Device-Stamp-Coordination-Research.md` (in-repo) — prior internal survey. This proposal supersedes its "Approach 2" by switching from real-time presence (which required GSOC or external infra) to lease-based partitioning with release-time state publication.
