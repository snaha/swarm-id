# Account architecture & multi-device state — refactor plan

Design / research reference for the account-architecture refactor. One continuum, three threads:

- **Credential model (#308)** — standardise on BIP-39 mnemonics as the root secret for all account
  types (status: **proposal / open** — see §3a).
- **Single-level account (#313)** — collapse the account→identity two-tier model into one **Account**
  (status: **decided** — see §"Two decisions already locked in" and §3b).
- **Multi-device account state (#337, #338, #339)** — a nested single-level account model (#339 + #313
  collapse), a single convergent merge layer with real deletions (#337), and the read/pull triggers that
  keep devices fresh (#338) — plus the design space for storing this on Swarm without re-shipping one big
  JSON blob per change.

Living doc; iterate here. The phase-by-phase record of what actually landed lives in a separate document:
[`Account-State-Refactor-Implementation-Log.md`](./Account-State-Refactor-Implementation-Log.md).

> **Pre-production: no migration.** The current version is not deployed. We are free to choose the
> target shape directly — there is no legacy on-disk data to migrate. Every "migration" concern below is
> therefore dropped; we build the new model as the only model.

## Two decisions already locked in

1. **Single hierarchy level, named "account."** Collapse the account→identity two-tier model (#313) to
   one entity called **Account** that _directly_ owns connected apps and postage stamps. The `identity`
   tier and all `accountId`/`identityId` pointers go away. Apps connect to the account's keypair;
   `ConnectionInfo.identity` maps onto the account. Rationale and trade-offs in §3b.
2. **Partitioning stays.** Postage-batch partitioning is a _separate, lower_ concern from account-state
   convergence (see §2). It exists because devices share one mutable postage batch's bucket slots, and
   that is true regardless of how account state is modelled.

The credential model (#308) is **not** locked in — it is captured as a proposal in §3a because it is
adjacent to, and supportive of, the single-level account decision, but it does not block this work.

---

## 1. Context & problem

Three issues, one cluster — multi-device account state that merges cleanly and stores well on Swarm:

- **#339** — local storage is four flat `localStorage` collections joined by string pointers
  (`swarm-id-accounts/identities/connected-apps/postage-stamps`), each with its own
  `VersionedStorageManager` and reactive store. Every read re-derives the tree by filtering global
  arrays; cross-cutting mutations hand-cascade across four stores in a careful order; the stamp↔account
  link isn't even stored (re-derived via `collectAccountStampBatchIds`). Meanwhile everything that
  _leaves_ the app already uses the nested `AccountStateSnapshot` shape, so we maintain two shapes and a
  fan-in/fan-out conversion (`restoreAccountToStores` ↔ snapshot).
- **#337** — the merge rules exist **twice** and can drift: `lib/src/sync/merge-snapshot.ts` (publish
  path) and `swarm-ui/src/lib/utils/refresh-account-from-swarm.ts` (refresh path). Also, only
  `connectedApps` can express a deletion (a `revokedAt` tombstone); **identities and stamps cannot** —
  the union merge silently re-adds a locally deleted entry on the next sync.
- **#338** — the read/pull side is under-wired: **agent** (seed-phrase) accounts create blank local
  state instead of restoring from Swarm; `refreshAccountFromSwarm` only runs when the Devices view
  mounts, so a device goes stale until the user happens to open that screen.

The user's framing ("better suit Swarm storage instead of storing several JSON objects") is two things:
the **local** four-blob model (#339), _and_ the **wire** model — today a single monolithic
`AccountStateSnapshot` JSON re-uploaded _in full_ on every change to one shared feed, which is what
forces the heavyweight write-arbitration on that feed.

## 2. The two coordination problems

These are conflated in the current code's mental model. Keeping them apart is the key insight.

| Concern                          | What it is                                                                                         | Mechanism today                                                                                                           | This work                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **A. Account-state convergence** | All devices agree on the set of identities/apps/stamps/devices                                     | One shared epoch feed + whole-snapshot upload + read-merge-rewrite + `verifyWon` retry races (`publish-account-state.ts`) | **In scope** — #337/#338/#339 + §7       |
| **B. Postage-batch slots**       | Devices sharing one _mutable_ postage batch must not stamp the same `(bucket, slot)` and overwrite | `partition-lock` / `partition-intent` / `partition-lease` / `batch-write-coordinator` (lease a disjoint partition)        | **Stays as-is.** Out of scope to remove. |

Concern B is genuinely needed (`docs/Postage-Batch-Partitioning.md`): a batch is a `bucket × slot` grid;
`PARTITION_COUNT=2` splits each bucket's slots so device 0 and device 1 never collide. Account-state
writes are _clients_ of this layer — they consume slots too. So account state sits **on top of**
partitioning, and a redesign of A must still write through B.

The elegant consequence (see §7): if each device writes only **its own** account-state feed, and a
device already owns **its own** partition, then account-state writes become naturally partition-aligned
(device _i_ → partition _i_ → device _i_'s feed) — concern A's write contention drops to ~zero while
concern B is unchanged.

## 3. Architectural decisions

### 3a. Credential model — mnemonics for all account types (#308)

> **Status: proposal / open.** Adjacent to and supportive of the single-level account decision (a
> mnemonic-rooted account is "the mnemonic _is_ the account"), but it does not block the state refactor.
> See [#308](https://github.com/snaha/swarm-id/issues/308).

**Background.** The three account types currently derive and protect their master key in incompatible
ways:

- **Ethereum account**: A custom "secret seed" (not BIP-39) is the root of the master key. The seed is
  encrypted using the _public key_ of the user's Ethereum wallet, so the user can decrypt it by signing
  a message. This means the wallet must not be used for on-chain transactions to avoid key reuse
  ([#85](https://github.com/snaha/swarm-id/issues/85)). The secret seed is a SwarmID-only concept with
  no industry precedent.
- **Passkey account**: The master key is derived from the output of the WebAuthn PRF extension. No
  mnemonic is involved. If the passkey is deleted, the account cannot be recovered
  ([#191](https://github.com/snaha/swarm-id/issues/191)).
- **Agent account**: Already uses a standard BIP-39 mnemonic (12–24 words). The mnemonic is not stored —
  it must be re-entered on each authentication. This is functional for bots but impractical for humans.

**Proposal.** Standardise on BIP-39 mnemonics as the root secret across all account types:

- **Ethereum**: The mnemonic is the root. The ETH wallet signs a deterministic EIP-712 message
  (confirmed non-random for MetaMask and Coinbase Wallet — [#200](https://github.com/snaha/swarm-id/issues/200)),
  producing entropy that encrypts the mnemonic at rest. The wallet is only used for encryption, not
  on-chain signing.
- **Passkey**: The mnemonic is the root. The passkey PRF output encrypts the mnemonic at rest. The
  passkey becomes a key-protection layer rather than the sole source of entropy.
- **Agent**: No change. The mnemonic is entered directly on each authentication.

**Advantages.**

1. **Portability** — A BIP-39 mnemonic can be taken to any device, entered offline, or backed up with a
   hardware wallet workflow.
2. **Familiarity** — The 12–24-word mnemonic is the dominant secret management pattern in Web3; users
   are more likely to understand and respect it.
3. **Cross-wallet compatibility** — Any standard Ethereum wallet can be used (including ENS-linked
   wallets), removing the current restriction that the wallet must not be used for on-chain transactions.
4. **Recovery without file backup** — The mnemonic becomes the primary out-of-band recovery path,
   superseding or complementing the `.swarmid` file export.
5. **Passkey as encryption layer only** — Passkey deletion no longer means account loss. The mnemonic
   survives and can be re-protected by a new passkey, resolving
   [#191](https://github.com/snaha/swarm-id/issues/191).
6. **Alignment across account types** — A single mental model applies to all types; the difference
   between them becomes only the encryption/protection mechanism.
7. **Enables Swarm backup for Ethereum accounts** — [#204](https://github.com/snaha/swarm-id/issues/204)
   proposes using an EIP-712-derived encryption key for Swarm-hosted backup. This becomes cleaner if the
   mnemonic is the thing being backed up.

**Disadvantages.**

1. **Breaking change — no silent migration** — Existing Ethereum accounts use a proprietary secret seed,
   not a BIP-39 mnemonic. There is no way to derive one from the other automatically. Existing users must
   re-create their account or go through an explicit migration with manual steps.
2. **Onboarding friction** — Presenting a mnemonic at account creation and requiring the user to write it
   down adds a step that slows sign-up. Passkey flows are currently frictionless.
3. **Additional credential to manage** — Users now hold: mnemonic (written down or in password manager) +
   wallet or passkey. For passkey-only users this doubles the secret count.
4. **Mnemonic exposure risks** — Whenever a mnemonic is displayed on screen or typed, it is susceptible
   to shoulder surfing, screen capture, or keylogging. The current passkey PRF flow never exposes a
   copyable secret.
5. **Password-protection UX** — To avoid the mnemonic being the only factor, a password or PIN to encrypt
   it at rest is desirable. This adds another screen and another secret to manage.
6. **Passkey flow becomes two-step** — Currently, passkey authentication is a single browser gesture.
   With a mnemonic encrypted by PRF, the PRF output must first decrypt the mnemonic before any key
   material is available, adding latency and complexity to the auth path.
7. **Agent UX unchanged** — Agents still need to enter the mnemonic on every authentication. The proposal
   does not materially improve the human-facing agent experience unless a password-protected keyfile is
   also introduced.

**Compatibility with PoC#1 Requirements.**

| Requirement                               | Impact                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Separate user identity from node identity | Not affected — identity key derivation hierarchy is unchanged                                                   |
| Persona separation (highly recommended)   | Not affected — personas still derived from identity keys                                                        |
| Swarm-based user metadata / master stamp  | Neutral — mnemonic-based root makes Swarm backup simpler ([#204](https://github.com/snaha/swarm-id/issues/204)) |
| JavaScript-only, no installation          | Not affected                                                                                                    |
| Future-proof interfaces                   | Improved — BIP-39 is a long-standing standard                                                                   |

### 3b. Single-level account (#313)

> **Status: decided** (see §"Two decisions already locked in"). The collapse is the foundation of the
> data model in §5. The rationale and trade-offs that were weighed are preserved below. See
> [#313](https://github.com/snaha/swarm-id/issues/313).

**Background.** The original data model had two tiers:

- **Account**: The authentication layer. Created once per credential (one passkey, one Ethereum wallet,
  or one mnemonic). Holds the master key derivation root, postage stamps, devices, and sync state.
- **Identity**: A derived key pair (account master key + identity ID → identity private/public key +
  address). Multiple identities could exist under one account. All identities shared the same
  authentication credential — unlocking the account unlocked all its identities simultaneously.

In practice the vast majority of users create exactly one identity per account. The extra tier added UI
steps ("create account, then create identity"), conceptual overhead ("what is an account vs. an
identity?"), and code complexity (every lookup had to join account and identity by `accountId`).

**Decision.** Collapse to a single **account** level. The credential (passkey, wallet, mnemonic)
directly protects a single key pair; there is no intermediate identity object. "Create an account" is the
only onboarding action. No `identityId`/`accountId` pointers; one storage key. The developer-facing API
(iframe postMessage protocol, `ConnectionInfo.identity`) is unchanged — its fields now carry the
account's id/name/address/publicKey.

**Advantages (rationale considered).**

1. **UX simplicity** — One flow instead of two. "Create an account" is a self-contained action with an
   immediately usable result.
2. **Clearer mental model** — Users reason about one entity, not two nested ones.
3. **True isolation between accounts** — Two accounts created with different credentials are
   cryptographically independent. Connecting a dApp to one gives zero access to the other, even for the
   same physical user.
4. **Code simplification** — Removes the identity tier, the account↔identity join in every lookup path,
   and simplifies the sync snapshot format (local shape == wire shape).
5. **Symmetric with #308** — If mnemonics become the root secret (§3a), the mnemonic _is_ the account.
   There is no natural extra tier to group sub-entities under.

**Disadvantages / trade-offs accepted.**

1. **Breaking change — data migration required** — Mitigated here: pre-production, so no on-disk data to
   migrate (see the migration note at the top).
2. **Multi-identity management is harder** — Holding several independent keypairs now means several
   accounts, each with its own credential. Accepted: this is the "multiple Google accounts" model (§5).
3. **Persona support becomes harder to add later** — The Requirements document calls persona separation
   "highly recommended." A persona is a sub-level below the account; flattening today means reintroducing
   a sub-level later. Accepted as **deferred future work**, not reintroduced now.
4. **Postage stamp and sync scope** — Stamps and the Swarm sync feed were account-scoped, shared across
   an account's identities. With one level, each account has its own stamp set and sync feed. Addressed
   by the account-owned postage-batch set with one default + per-app override (§5).
5. **Cross-identity content sharing** — Sharing ACT-encrypted content between two identities of the same
   user was straightforward under a shared master key. Independent accounts are fully isolated; cross-
   account sharing uses the normal grantee mechanisms.
6. **Authorization granularity is reduced** — Use cases wanting multiple personas that share a stamp
   budget or app list lose that at the data layer until personas return as future work.

**Compatibility with PoC#1 Requirements.**

| Requirement                               | Impact                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Separate user identity from node identity | Satisfied — the account key pair IS the user identity                                     |
| Persona separation (highly recommended)   | **Tension** — personas need a sub-level below the account, which reintroduces hierarchy   |
| Swarm-based user metadata / master stamp  | Each account has its own master stamp — increases Swarm footprint for multi-account users |
| External stamp management                 | Still feasible, but per-account                                                           |
| JavaScript-only, no installation          | Not affected                                                                              |

## 4. Current architecture (concise map, with refs)

**Wire shape** — `AccountStateSnapshot` (`lib/src/schemas.ts:274-282`):
`{version, timestamp, accountId, metadata{accountName, defaultPostageStampBatchID, createdAt,
lastModified, devices[], partitionCount}, identities[], connectedApps[], postageStamps[]}`.

**Merge rules** (`lib/src/sync/merge-snapshot.ts`, mirrored in `refresh-account-from-swarm.ts:39-73`):

- identities — union by `id`, **local wins**, _no tombstone_ (deletion bug).
- postageStamps — union by `batchID`, **local wins**, _no tombstone_ (deletion bug).
- connectedApps — LWW by `updatedAt ?? lastConnectedAt`, key `${identityId}:${appUrl}`, with `revokedAt`
  tombstone (the one collection that _can_ delete).
- devices — union by `deviceId`, prefer larger `lastSignedInAt`.

**Write path** (`publish-account-state.ts`): derive topic `swarm-id-backup-v1:account:${accountId}` +
owner from `deriveSecret(swarmEncryptionKey,"backup-key")` → fetch remote snapshot → merge → upload
_whole_ JSON encrypted (`uploadData`) → advance epoch feed SOC → `verifyWon` re-read, retry up to 3× on
loss. Wrapped by `BatchWriteCoordinator` (Web Lock on `batchId` + partition lease).

**Read path** (`restore-account.ts`, `refresh-account-from-swarm.ts`): same topic/owner →
`AsyncEpochFinder.findAt(now)` → download+decrypt → deserialize → merge into stores.

**Local model**: four `VersionedStorageManager`s (`lib/src/utils/storage-managers.ts`) + four
`*.svelte.ts` stores; proxy (`lib/src/swarm-id-proxy.ts:1187-1251`) reads all four keys directly and
subscribes to each to compute `ConnectionInfo`.

**Prior art**: PR #332 / commit `bcbeb595` prototyped a `SyncedAccount` aggregate-root facade (each
mutation declares its own sync intent) over the flat stores — the behavioural half of #339. kalkul-next
(`snaha/kalkul-next`) already ships the nested-doc + store-enrichment pattern we want.

## 5. Target data model (single-level account)

```ts
Account {                       // the aggregate root AND the keypair apps connect to
  id; name; type; createdAt; derivationKey
  // type-specific: credentialId (passkey) | ethereum fields | (agent none)
  devices: Device[]
  defaultPostageStampBatchID            // the account's DEFAULT batch (see "Postage batches" below)
  connectedApps: ConnectedApp[] {       // was identity-owned; now account-owned (drop identityId)
    // …app fields
    postageStampBatchID?                // optional per-app override; falls back to the account default
  }
  postageStamps: PostageStamp[] // account-owned set; the derived stamp↔account link becomes a fact
  // convergence metadata — see §6 (per-entry tombstones now; dots/version-vector at §7)
}
```

- Containment replaces pointers; orphans become unrepresentable; account delete = drop one tree.
- **Local shape == wire shape.** The snapshot stops needing fan-in/fan-out — save/restore/sync become
  near-identity transforms. One versioned document per account replaces four per-collection managers.
- The proxy reads one nested doc and subscribes once (instead of four keys).

### Independent keypairs = separate accounts (resolves §8 Q1)

If a user wants cryptographically independent keypairs, they create **multiple accounts** — exactly like
holding multiple Google accounts. There is no sub-identity tier; the account list is the multiplicity.
Personas (a level _below_ the account) remain deferred future work, not reintroduced now.

### Postage batches: many per account, one default, per-app override

An account owns a **set** of postage batches (`postageStamps[]`) and designates one as its
**default** (`defaultPostageStampBatchID`). The default batch:

- stores the **account data** itself (the account-state snapshot / per-device feeds), and
- is the **default for app data** uploads.

Each connected app may **override** the batch it uses via `connectedApps[].postageStampBatchID`; absent
an override it uses the account default. This makes "which batch pays for this upload" an explicit,
account-scoped choice rather than a derivation — and removes the old `collectAccountStampBatchIds`
re-derivation (and the now-defunct identity-level `defaultPostageStampBatchID`). Partitioning (concern
B, §2) continues to operate **per batch**, unchanged.

## 6. Design-space research (the core)

### 6.1 Framing: this is local-first, and we already have an ad-hoc CRDT

Kleppmann's _Local-First Software_ ideals (offline work, multi-device, no central server, eventual
convergence) describe exactly this system. The current union+LWW+tombstone merge **is** an informal
**state-based CRDT** — each publish ships full state and merges by a join. That's the right family; the
problems are (a) the join isn't a clean lattice for identities/stamps (no deletes → not a real
remove-capable set), (b) full-state ship is bandwidth-heavy and forces single-feed arbitration.

### 6.2 State-based vs operation-based (and Merkle-CRDT)

- **State-based** (today): ship whole state, merge by join. Tolerant of dropped/reordered/duplicated
  messages — good for Swarm's "read latest feed" model. Cost: O(state) per write.
- **Operation-based / log**: ship individual ops; needs exactly-once causal delivery — too strong an
  assumption over plain feeds.
- **Merkle-CRDT** (OrbitDB's model; Psaras & Sanjuán 2020): an **append-only op-log whose entries are
  content-addressed and link to their causal predecessors**. The Merkle-DAG _is_ the logical clock —
  causality travels in the links, not in per-object vector clocks. Converges with almost no messaging
  guarantees. Natural fit for content-addressed Swarm: each device keeps its own log; merge = fetch
  peers' logs and fold. OrbitDB runs exactly this over IPFS.

### 6.3 Deletes done right (fixes #337's core gap)

The union-with-local-wins can't delete because a re-added element is indistinguishable from a survivor.
Standard fixes, in increasing power:

- **LWW-element-set with tombstones** (what `connectedApps` already does): keep `deletedAt`; an entry is
  present iff its latest op is an add and `add > delete`. Simple; needs a clock; tombstones accrete.
- **OR-Set (observed-remove, add-wins)**: tag each add with a unique `dot` (`deviceId × counter`); a
  remove tombstones _the dots it observed_. Concurrent add-after-remove wins (intuitive for "I re-added
  it"). The rigorous version of the tombstone pattern.
- **Version vectors / causal stability**: track `deviceId → counter`; once all devices have observed a
  dot it's _causally stable_ and its tombstone can be **garbage-collected** — solves unbounded tombstone
  growth (the thing that eventually bloats the snapshot).

**Recommendation for #337**: unify on **one merge module** exporting per-collection primitives
(`unionByKey`, the LWW+tombstone merge, device union) consumed by both publish and refresh — and extend
the **`deletedAt` tombstone pattern to identities and stamps** so all three collections can delete.
Treat full OR-Set/version-vector as the upgrade path documented for the north-star phase (§7), not
required for the first cut.

### 6.4 Storage efficiency (the "stop shipping one big JSON" half)

- **Delta-state CRDTs** (Almeida et al. 2018): ship only the _delta_ since last sync, not full state —
  same convergence, far less bandwidth.
- **Automerge 2.0 incremental**: `saveIncremental()` appends a compressed change chunk; periodic
  compaction to a snapshot. Storage = `[snapshot chunk] + [incremental chunks…]`.
- **Maps onto Swarm directly**: a per-device **append-only feed of change chunks** + an occasional
  compacted snapshot is the Swarm-native version of this. Each change is a small 4KB-ish SOC, not a
  re-upload of the whole account. Chunk content-addressing gives natural dedup.

### 6.5 Swarm primitive mapping

- A **feed** = SOC sequence under `(owner, topic)`; many independent feeds are cheap (just vary topic).
  Latest = highest consecutive index (a few lookups). Payload ≤ one 4KB chunk → big state still needs a
  reference-chunk to a chunked blob (as today via `uploadData`).
- **Per-device feed**: `topic = H("swarm-id-oplog-v1" ‖ accountId ‖ deviceId)`, owner derived as today.
  Device writes only its own feed → no cross-device feed race. Reader enumerates known `deviceId`s (from
  the device registry, itself a small CRDT set) and folds all logs.
- **Partition alignment**: device _i_'s feed writes ride device _i_'s already-leased partition slots, so
  concern B is satisfied for free for account-state writes.

### 6.6 Options compared

| Option                                      | Convergence              | Bandwidth/write | Write contention (concern A)       | Deletes            | Effort | Risk     |
| ------------------------------------------- | ------------------------ | --------------- | ---------------------------------- | ------------------ | ------ | -------- |
| **Keep single-feed snapshot** (status quo+) | state-based join         | O(full state)   | high (one feed, verifyWon retries) | tombstones (all 3) | low    | low      |
| **Delta on single feed**                    | state-based + δ          | O(change)       | still single feed                  | tombstones         | med    | med      |
| **Per-device-log Merkle-CRDT** (north star) | op-log, causal via links | O(change)       | ~none (own feed)                   | OR-Set/VV          | high   | med-high |

## 7. Recommended direction — phased

Pragmatic now, with a clear north star. Each phase ships independently and leaves `pnpm check:all`
green. No migration step (pre-production): build the nested model as the only model.

- **Phase 0 — Nested single-level account local model (#339 + #313 collapse).**
  Introduce one versioned nested `Account` document (one storage key, one `VersionedStorageManager`)
  that _is_ the `AccountStateSnapshot` shape. Build the store-enrichment/aggregate API on it (complete
  the `SyncedAccount` facade from #332 so the account owns persistence). Collapse identity→account: drop
  the identity tier, move apps + stamps under the account, delete `accountId`/`identityId`. Move the
  proxy's four-key reads to the one doc.

- **Phase 1 — One merge source of truth + real tombstones (#337).**
  Make `lib/src/sync/merge-snapshot.ts` export the per-collection primitives; delete the duplicate
  helpers in `refresh-account-from-swarm.ts` and import them. Add `deletedAt` tombstones to identities
  and stamps so deletions propagate. One shared unit test covering LWW/tombstone + device-union.

- **Phase 2 — Read/pull triggers (#338).**
  Give **agent** accounts a restore-from-Swarm path on (re-)entry (mirror passkey/ethereum
  `restoreAccountFromSwarm`). Call `refreshAccountFromSwarm` on app load and on account switch (from the
  `(app)` root layout / account-switch hook), not just the Devices view.

- **Phase 3 — North star: per-device-log CRDT for account state.**
  Replace the single shared snapshot feed with one append-only **change-log feed per device** + periodic
  compacted snapshot (delta-state / Merkle-CRDT). Reader folds all device logs. Upgrade deletes to
  OR-Set/version-vector with **causal-stability GC** of tombstones. This retires concern-A write races
  and the `verifyWon`/retry dance — **but not** the partition machinery (concern B stays). Account-state
  writes become partition-aligned per §6.5. Biggest change; do it only after 0–2 prove the model.

## 8. Open questions

1. **Multiple keypairs going forward.** ✅ Resolved — independent keypairs = **separate accounts** (like
   multiple Google accounts; see §5). Personas (a sub-level below the account) are deferred future work,
   not reintroduced now.
2. **Deletes: tombstone-LWW now, OR-Set later?** Confirm the phasing in §6.3.
3. **Tombstone GC**: adopt version-vector causal stability in Phase 3, or accept slow growth + periodic
   snapshot compaction? (§6.3 / §6.4)
4. **Stamp placement.** ✅ Resolved — stamps are an **account-scoped set** with one default batch; apps
   may override per-app (§5 "Postage batches"). The identity-level `defaultPostageStampBatchID` is
   dropped along with the identity tier.
5. **Interaction with #308 (mnemonics)**: single-level account aligns with "the mnemonic _is_ the
   account" — supportive, kept separable. The mnemonic-credential proposal itself is in §3a (status:
   open).
6. **Encryption of per-device feeds** (Phase 3): keep snapshot encryption; confirm change-chunks use the
   same `swarmEncryptionKey`.

## 9. Verification strategy

- **Per phase**: `pnpm check:all` green; targeted Vitest in `lib/src/sync/*.test.ts` (extend
  `merge-snapshot.test.ts` as the single merge-rule oracle).
- **Multi-device E2E** (per `project_e2e_auth_testing` / `project_stale_tab_multidevice` notes): drive
  two seed-phrase agent accounts against the local Bee cluster; create/delete an app and a stamp on
  device A; assert device B converges on load/account-switch (not only on the Devices view) and that
  **deletions propagate** (the #337 fix). Fully close/reopen tabs to avoid stale HMR lib code before
  trusting results.
- **Phase 3 extra**: assert a device only writes its own feed (no cross-device feed overwrite), and that
  fold-of-logs == old snapshot merge for the same op set (differential test against Phase 0–2 behaviour).

## 10. References (research basis)

- Kleppmann et al., _Local-First Software: You Own Your Data, in spite of the Cloud_ —
  https://martin.kleppmann.com/papers/local-first.pdf
- Psaras & Sanjuán, _Merkle-CRDTs: Merkle-DAGs meet CRDTs_ (OrbitDB's model) —
  https://arxiv.org/pdf/2004.00107
- Almeida, Shoker, Baquero, _Delta State Replicated Data Types_ / _Efficient State-based CRDTs by
  Delta-Mutation_ — https://arxiv.org/pdf/1603.01529 , https://arxiv.org/pdf/1410.2803
- Shapiro et al., OR-Set / _An optimized conflict-free replicated set_ — https://arxiv.org/pdf/1210.3368
- Baquero et al., _Approaches to CRDTs_ (version vectors, causal stability, GC) —
  https://arxiv.org/pdf/2310.18220
- Automerge 2.0 — binary/incremental format & sync — https://automerge.org/blog/automerge-2/ ,
  https://automerge.org/automerge-binary-format-spec/
- OrbitDB (Merkle-CRDT OpLog over IPFS) — https://orbitdb.org/
- Weidner, _CRDT Survey Part 3: Algorithmic Techniques_ —
  https://mattweidner.com/2023/09/26/crdt-survey-3.html
- bee-js — SOC & Feeds — https://bee-js.ethswarm.org/docs/soc-and-feeds/
- DSON — delta-state CRDT for JSON-like data — https://github.com/helsing-ai/dson
- Internal: `docs/Postage-Batch-Partitioning.md`, PR #332 / commit `bcbeb595` (`SyncedAccount` facade),
  `snaha/kalkul-next` (nested-doc prior art).

## 11. Implementation log

The phase-by-phase record of what actually landed lives in a separate document:
[`Account-State-Refactor-Implementation-Log.md`](./Account-State-Refactor-Implementation-Log.md).
