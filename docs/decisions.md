# Decisions

Architecture and product decisions, newest first. One entry per decision: the
context in a line or two, the decision, and why. Append only; a reversed
decision gets a new entry that names the old one. Code comments describe the
present and may point at an issue or PR; the reasons live here.

A PR that makes or changes a decision adds the entry in the same PR.

## 2026-11-24 Issues carry a type, at most one stage label, and topic labels

**Context.** The `Design` label meant both "needs designing" and "visual fix to built UI", and
nothing said when a design was finished, so the issue stayed with the designer. `question` mixed
design questions with technical ones, `bug`/`enhancement` repeated the org's issue types, and most
open issues had no label at all ([#1063](https://github.com/snaha/swarm-id/issues/1063)).

**Decision.** The kind of issue is its issue type (Bug, Feature, Task), not a label. Its stage is at
most one of `needs design`, `needs decision`, `ready for implementation` and `blocked`; no stage
label means not yet triaged. A design is handed off by swapping `needs design` for
`ready for implementation`, with the final Figma frames in a comment, and the designer unassigning.
Checking the built UI against the design is a PR review the designer is requested on. `Design` and
`question` were renamed in place; `bug`, `enhancement`, `help wanted`, `good first issue`,
`duplicate`, `invalid` and `wontfix` were deleted. The state before the change, with a restore
script, is in a comment on #1063.

**Why.** "Ready for implementation" is the moment work changes hands, so it needs a signal of its
own that anyone can filter on. One stage at a time keeps that filter honest. Types and GitHub's
close reasons already say what the deleted labels said.

## 2026-11-23 `immutableFlag` is recorded, never checked

**Context.** Three places decided on a batch's on-chain `immutableFlag`. "Use existing batch"
refused a batch that has it set ([#862](https://github.com/snaha/swarm-id/issues/862), the
immutable-import check of #864), on the reasoning that a partition's lock and state chunks overstamp their slots and a
scratch drive reuses its data slots. Resize refused it, and delete-time dilution skipped it,
because Bee's handling of a diluted immutable batch was undefined.
[#1056](https://github.com/snaha/swarm-id/issues/1056) asks for such batches to be usable.

**Decision.** Nothing in Swarm ID decides on `immutableFlag`: import, resize and delete-time
dilution treat an immutable batch like any other. The flag is still recorded on the stamp, as
the chain reports it. This reverses the mutable-only rule of #862; Swarm ID's own purchases
keep passing `false`.

**Why.** The flag's semantics are unclear and it is slated for removal from the contract
([storage-incentives#317](https://github.com/ethersphere/storage-incentives/issues/317)).
Whether data is immutable is then the application's choice, not a property of the batch, and
the contract enforces nothing on it today either. Refusing on it locks out batches a user
already paid for, on the strength of a property that may stop existing.

## 2026-11-18 The live Relay suite runs where a Relay change can show

**Context.** `relay.live.test.ts` quotes Relay's real API and ran as a job of
`ci.yml` on every PR. Relay changes without a commit of ours, so a bad hour
there turned every open PR red whatever it touched (#843), and runs that
started together were answered with HTTP 429 (#1049).

**Decision.** The suite has its own workflow, `live-contracts.yml`. It runs on
a PR that touches the payment code, the suite's config, the lib's timeout
helpers or the lockfile, on every push to `main`, nightly, and on demand. Its
runs share no concurrency group.

**Why.** A red check on a PR should mean the PR broke something. `main` and the
nightly run still date a change on Relay's side to a day, though a failed
nightly run notifies only whoever last edited its `cron` line, so it is seen by
opening the Actions tab. A workflow of its own takes a `paths` filter and a
schedule without either applying to the rest of CI. The filter alone removes
almost all the overlap behind the 429s: every one recorded in #1049 came from a
PR that no longer runs the suite. A shared concurrency group was rejected:
GitHub holds one pending run per group, so a queued PR run would be dropped for
a later run on another ref, and the nightly run tests `main`, never that PR's
head. The 429s that remain are the suite's to handle (#1049).

## 2026-11-18 A request's timeout does not count the wait for its drive

**Context.** Writes to one drive run one at a time, under its cross-tab lock
and its partition lease, and the client's timeout ran from the moment a
request was posted. A write behind a long upload therefore timed out while
nothing was wrong, and then ran anyway once the drive was free, spending
stamps for a caller already told it had failed.

**Decision.** Once a write has waited a second for its drive the proxy says
`requestQueued`, then on a 5-second beat; the client waits the longer of the
request's timeout and 90 seconds between beats, and `requestStarted`, said
only after `requestQueued`, restarts the timeout at its full length. A write
that gets its drive within the second says neither. A request that expires on
that silence says so, and how long it waited. Nothing caps the queue in all:
on the local cluster an encrypted upload moves about 1.8 MiB a second, so a
file of a few GiB holds its drive for hours. Every request that expires on the
client is aborted in the proxy, and a write aborted while it queues for the
lock, or waits for a partition slot, stops waiting at once and claims none.
This narrows "A per-call timeout bounds the whole round trip" below. An
upload's progress is posted at most every 250 ms, the last report always.
(#1042)

**Why.** A lone write is most writes, and saying nothing for it costs no
messages and shows an older client, which knows neither, nothing it would
reject; a second is short enough that a caller's timeout does not run out
before the client hears the write is queued. The beat is what tells a long
queue from a proxy that has died: a dead one says nothing and is still caught
within 90 seconds, or the request's timeout when that is longer. A browser may
run a hidden page's repeating timers only once a minute, so a live proxy's
beats can arrive a minute apart: 90 seconds is that minute plus slack. No
fixed cap fits both a small write and one behind a multi-hour upload, and the
holder is ended by its own deadlines; a caller who will not wait passes
`requestOptions.signal`. A report per chunk is hundreds of thousands of
messages for a large file, each parsed on the dApp's main thread.

## 2026-11-18 Every upload builds its Merkle tree as the chunks are sent

**Context.** A plain upload and an encrypted one each had a pipeline of their
own. Both cut the whole input into chunks first and built the tree a level at
a time over every reference, so memory grew with the input, and a plain upload
sent its chunks one after another whatever `concurrency` said.

**Decision.** One pipeline serves both. It reads the input as a sequence of
pieces, sends each 4096-byte chunk through a window of at most `concurrency`
sends, and keeps one partial intermediate chunk per tree level, wrapping a
level the moment it is full. Plain uploads honour `concurrency`; left unset
they still go one at a time. References are unchanged. (#1041)

**Why.** A chunk's reference follows from its bytes, so the tree never has to
wait for the node, and what an upload holds is then bounded by the window
rather than by the input. That bound is what lets an input larger than memory
be uploaded at all, and waiting for a free slot in the window is the
backpressure such an input needs.

## 2026-11-18 Previews use production's signaling server; a PR that changes the server gets a Render instance

**Context.** The GitHub Pages builds (`main` and the per-PR previews) had no signaling
server: they were built without `PUBLIC_BUS_SIGNALING_URL`, and production's server admitted
only its own origin. A preview could not show anything that needs two devices, nor a change
to the server itself.

**Decision.** Production's server admits `https://swarm.snaha.net`, and every build there
uses it. A PR that touches `signaling/` deploys its head commit to one free Render web
service (`render.yaml`) and its preview is built against that instead.

**Why.** Production's server already tracks `main` on every push, with no cold start, so
nothing else has to be kept on `main`: a second server that also had to follow `main` went
stale on a push to `main`, on a failed restore, and on a PR that reverted its server change.
Preview traffic on production's relay is the accepted cost; rooms are per account. The
Render instance exists only because a PR's server cannot run in production's container
without restarting production. It is one shared instance (two open PRs that both change
the server take turns), it sleeps after 15 idle minutes, and an account open in such a PR's
preview and in another preview does not see itself live, since the two sit on different
servers.

## 2026-11-13 SvelteKit 3, with `$lib` kept as an alias

**Context.** SvelteKit 2 carried two advisories fixed only in 3.0 and pinned
the apps to vite 7, whose dev-server advisories were accepted on the audit
list (#1020, #1021). SvelteKit 3 requires vite 8, vite-plugin-svelte 7 and
TypeScript 6, and no longer generates `$lib`: its replacement is the `#lib`
subpath import, which requires a file extension on every import.

**Decision.** The whole pinned toolchain moves at once: SvelteKit 3,
adapter-static 4, vite 8, vite-plugin-svelte 7, TypeScript 6 in every package.
The SvelteKit config lives in each app's `vite.config.ts`, and public
variables are declared in `src/env.ts`. `$lib` stays, through SvelteKit's
deprecated `alias` option.

**Why.** Moving everything together keeps one TypeScript and one vite across
the monorepo, which is what the pin is for. `$lib` stays because `#lib` would
rewrite some 800 import lines and add the extensions the import style omits;
that is its own change (#1025), due before SvelteKit drops `alias`. TypeScript 6
types a `Uint8Array` by its buffer, and neither a Web API nor a message schema
takes one that may sit on shared memory: the lib casts where it hands bytes to
either (`webBytes`), so the byte types it publishes stay as they were.

## 2026-11-11 A dependency audit gates the release and the production deploys

**Context.** `pnpm audit` was run by hand, when someone thought of it, and its
findings went into `overrides`. Nothing stopped a release or a deploy from
shipping a dependency with a published advisory.

**Decision.** `pnpm audit` runs before the npm publish and before both
production deploys (DigitalOcean and the `main` build on GitHub Pages), and a
red run stops them. PR previews are not gated. It covers dev dependencies too,
at every severity. An advisory that is accepted is listed with its reason
under `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`. Each group names
the issue that clears it, and the audit fails on a listed advisory that is no
longer reported, so the list shrinks as fixes are taken.

**Why.** The exact pins and the release-age gate cover a release nobody has
reported yet; the audit covers one that has been. Dev dependencies are in
scope because the apps bundle theirs: `svelte` and `@sveltejs/kit` are
`devDependencies` of `ui/` and ship in every page, which `--prod` would skip.
No severity floor, because the list is what makes a clean run possible, and a
floor would hide the next moderate advisory in code that does ship. Previews
stay open so that a new advisory does not stop review of unrelated work.

## 2026-11-10 `useWebSocket` applies to every stamper upload

**Context.** Only encrypted uploads read the option; a plain upload took HTTP
without saying so. Bee's `/chunks/stream` defers a chunk exactly when the stream
has a tag, and has no pinning.

**Decision.** Plain uploads use the stream too, and a refused upgrade fails the
upload instead of falling back to HTTP. A direct stream goes untagged, and
`pin: true` or a `tag` without `deferred: true` is rejected before the write
lock is taken, wherever the upload goes to a stamper. A deferred stream the
node gives no tag for is rejected too, and tag 0 is no tag, as Bee reads it.
Subsidised mode keeps HTTP and rejects none of these. An ACT upload sends its
content over the stream as well. Single-chunk writes do not take the option in
their type.

**Why.** The transport has nothing to do with encryption, and the gateway
argument for skipping it applied equally to encrypted uploads, which already
fail there with an error naming the cause. An untagged direct stream keeps the
`deferred` contract of 2026-09-21, at the cost of Bee handling direct chunks one
at a time. A `tag` would defer the stream, so dropping it unannounced would be
the same silent difference as the dropped option, and an untagged deferred
stream would be a direct upload. A dApp cannot choose subsidised mode, and the
data still lands, so that case is documented on the option rather than
rejected: refusing there would make one call succeed or fail by the account's
drive. The stream carries only content-addressed chunks, and one chunk gains
nothing from it, so a single-chunk write offering the option would only drop it.

## 2026-11-09 Dependency versions are exact

**Context.** Dependencies were pinned once (#18); caret ranges crept back through
feature PRs, 35 of them, including `@ethersphere/bee-js: ^13.0.0` in four
packages. `@ethersphere/bee-js@13.3.0`, published 2026-11-09 with a malicious
`postinstall`, sits inside that range. In this repo three things stood in its
way: the lockfile, resolved to 13.0.0; pnpm's release-age gate, which refuses
a release under a day old on a fresh resolution; and `allowBuilds`, which does
not name bee-js, so its `postinstall` would not have run. An npm consumer of
`@snaha/swarm-id` has none of them: `0.8.0` shipped `^13.0.0`, so a fresh
install while 13.3.0 was up could resolve to it and run the script.

**Decision.** Every `package.json` names an exact version, `savePrefix: ''`
makes `pnpm add` write one, and a bump is a reviewed edit plus `pnpm install`.
pnpm's release-age gate stays at its default of one day; a release that must
ship younger than that is named in `minimumReleaseAgeExclude` in the same PR,
since a local override does not survive CI's frozen install. (#982, #984)

**Why.** A range lets the registry decide what a fresh resolution installs,
and a compromised release is pulled within hours of the first report, after
the installs it was aimed at. The published `package.json` is the only one of
these defences that travels to whoever installs the library, so the exact
version there is what protects them. In the repo it makes the diff the place
where an upgrade is seen; the age gate holds back any fresh release, whether a
range reaches it or a pin names it on purpose. Three days was considered for
the gate, to span a weekend; the default was kept because a takedown takes
hours, not days, and the exclude list already carries the deliberate
exceptions.

## 2026-09-21 Stamper-mode uploads honour the caller's `deferred`

**Context.** Every data and chunk upload in stamper mode forced
`deferred: false`, so a caller's `true` was silently dropped.

**Decision.** Stamper mode passes the caller's `deferred` through. (#784)

**Why.** Setting the flag from `getNodeInfo()` is the documented remedy for a
node that needs it, and dropping it made the upload time out anyway.

## 2026-09-17 A per-call timeout bounds the whole round trip

**Context.** `requestOptions.timeout` reached only the Bee request inside the
iframe, while the client's own round-trip timer kept the constructor default.

**Decision.** The per-call value bounds the client's round-trip timer as well
as the Bee request. (#775)

**Why.** A per-call value above the default still rejected at the default,
with the same message the caller was trying to escape.

## 2026-09-11 Balances are read through the chain's own endpoint

**Context.** #534 read balances through the wallet wherever it was on the
selected chain, for the figures the wallet itself shows.

**Decision.** Balances are read through the chain's own endpoint, never the
wallet. Reverses #534.

**Why.** Over WalletConnect every read is a relay round trip to the user's
phone, and a session left holding responses nobody is waiting for redelivers
them for the rest of its life.

## 2026-09-11 `AlreadyKnown` from a node is a success

**Context.** `AlreadyKnown` took the write retry's rethrow branch.

**Decision.** It counts as a successful broadcast: the node has the
transaction.

**Why.** Once a send reached any mempool, every resend of those bytes failed,
the user's Try again included, because the nonce and the payload do not change
on their own.

## 2026-09-04 One saved session per dApp origin

**Context.** Storage is partitioned by iframe origin and top-level site, and a
site ignores the subdomain, so two dApps under one site share a store. The
saved session lived under one fixed key.

**Decision.** The handover is saved under
`partitionSessionStorageKey(parentOrigin)`. (#671)

**Why.** The second dApp to connect overwrote the first one's session, and
both needed the popup again on every reload.

## 2026-09-04 A refused handover ends the connect attempt

**Context.** A payload that failed the schema left the proxy's spinner running
while the popup, which cannot tell it was refused, said "Connected!". It was
also rejected further on as coming from an unauthorized origin.

**Decision.** A refused handover ends the attempt it belongs to, and the log
names the schema failure. (#587, #678)

**Why.** A refused handover is the ordinary way a version-skewed identity
deployment fails, and it must not read as an origin bug. Only closing the
popup cleared the spinner, which the user had no reason to do.

## 2026-09-04 Lease lanes are per (batch, partition)

**Context.** One partition-lock namespace was shared across all of an account's
batches.

**Decision.** Lock, intent and occupancy addresses are derived per (batch,
partition), and a `lease-request` names its batch. (#589)

**Why.** A holder on one batch and a waiter on another contend for nothing.

## 2026-09-04 A connected app's membership merges on the fields that state it

**Context.** One clock bumped by every write ranked the entry, so a drive
picked on a stale copy outranked a revoke and restored the credential it had
cleared. A dApp-initiated Disconnect wrote `lastConnectedAt: 0`.

**Decision.** Membership merges on
`max(revokedAt, disconnectedAt, lastConnectedAt)`, and a Disconnect sets
`disconnectedAt`. (#681, #682)

**Why.** A zero loses every merge, so the entry's old timestamp came back on
the next fold and the Disconnect never reached a peer.

## 2026-09-03 Only a genuine sign-in re-activates a device

**Context.** `mergeDevices` stamped our own entry on every poll, and the
announce path read a tombstoned self as "not yet announced".

**Decision.** A poll touches neither `removedAt` nor `lastSignedInAt`.
Re-activation happens at `reactivateThisDevice`, the one seam that can tell a
user unlocking their account from a timer. A tombstoned self stands down.
(#337, #611, #652)

**Why.** Clearing the tombstone undid every removal on the next round, and
republishing without it resurrected the device on every peer. Stamping the
field made every fold a byte change, which a proxy holding a partition
answered with a bus delta and a stamped feed write.

## 2026-09-03 Device names and app grants have clocks of their own

**Context.** Three dApps on one Safari are three partition devices, and a
corrected label moves neither `lastSignedInAt` nor `removedAt`.

**Decision.** A device's name merges on its own `nameUpdatedAt`, and a
connected app's grant field by field on its own clocks. (#643, #663)

**Why.** Without a clock a corrected row ties with every stale copy of itself
and loses, so every other context keeps the stale name forever.

## 2026-09-01 A partitioned session survives a reload

**Context.** The handed-over session lived only in memory, so every page load
re-ran the connect popup. On Safari, where partitioned is the ordinary mode, a
plain reload was a logout.

**Decision.** The handover is persisted in the partition's own store, under
the same 30-day deadline as the unpartitioned path. A restored session comes
up at once and checks the account's Swarm state in the background. (#635)

**Why.** The deadline cannot see a revoke made while the tab was closed, and
persisting removes the re-handshake that caught it. Trusting local storage
first and learning of a remote revoke after is what the unpartitioned path
already does.

## 2026-09-01 A session requires the account projection

**Context.** A payload with no account built a "download-only" session with no
stamps and no `derivationKey`.

**Decision.** `AuthDataSchema` requires the projection, so such a payload is
refused. (#642)

**Why.** Without a `derivationKey` a session derives no bus topic, joins no
room and can never be told it was revoked. No session beats a session nothing
can reach.

## 2026-09-01 An endpoint that cannot be identified gets no bridged rail

**Context.** A genesis probe that blipped was routed like a proven dev chain.

**Decision.** "Not proven mainnet" is not "proven dev": an unidentified
endpoint gets no bridged rail.

**Why.** A wallet pointed at real Gnosis was offered a local rail that takes a
deposit on a chain the destination has never heard of.

## 2026-08-31 The auth transport follows the storage mode

**Context.** `connect()` picked its transport by user agent, so a partitioned
Chromium was put on the storage-event path while only WebKit got the handover.

**Decision.** The iframe's storage probe decides, and `proxyReady` reports it.
(#613, #630)

**Why.** A partitioned iframe can only be reached by the popup it opened
itself, and no user agent says which mode an iframe is in.

## 2026-08-31 A handover carries only what the grant names

**Context.** The partitioned handover shipped every stamp with its signer key.

**Decision.** The handover is limited to the stamps this app's grant names.
(#578)

**Why.** The session runs in a context embedded by an arbitrary dApp page. It
can only spend the drives it was granted, so the other signer keys are pure
exposure.

## 2026-08-31 The payment method is chosen before any balance read

**Context.** The funding seam was the only place to choose, and it is raised
only when the owner address is short.

**Decision.** The chooser precedes the balance read. (#619)

**Why.** An account holding funds from an earlier attempt was committed to the
built-in engine with no way to say otherwise, and a purchase that could not
reach the chain failed before the question was put.

## 2026-08-27 The signaling room topic travels in the `join` frame

**Context.** The topic travelled as `/?topic=<hex>`.

**Decision.** It goes in the first frame, and the URL form is refused. (#577)

**Why.** The topic is the room capability, and query strings are recorded by
every ingress and proxy access log.

## 2026-08-27 A device registry merge is saved when any field moves

**Context.** The refresh persisted a merge only when the list got longer.

**Decision.** A merge that moved any field is saved, `lastSignedInAt` and
tombstones included.

**Why.** `activeDeviceIds` prunes the rival set on those fields, so a peer the
roster shows as live could age out of the stored copy, miss the intent round
and dual-acquire.

## 2026-08-26 Bus channels are per account

**Context.** The local channel was one origin-wide constant, harmless while the
only traffic was batch-scoped counters.

**Decision.** The topic comes from `deriveBusContext`, the same value the
signaling transport uses as its room.

**Why.** `account-delta` carries `postageStamps[].signerKey`, so co-resident
accounts must not share an unencrypted channel.

## 2026-08-26 A `lease-request` ranks the holders

**Context.** One waiter's `lease-request` made every idle holder yield.

**Decision.** Every holder takes a rank from the request id, and holders
further down the order stand down on a claim. The schema drops an id that does
not parse to a rank. (#576)

**Why.** An id that parses to NaN or a negative puts every holder at rank 0,
which is the same stampede, silently.

## 2026-07-13 Plain Merkle trees use 128-ref intermediate chunks

**Context.** Plain uploads built intermediate chunks with a 64-ref fanout.

**Decision.** The plain Merkle layout matches what a stock node builds, 128
refs per intermediate chunk. (#417)

**Why.** Bee could not join trees built with a 64-ref fanout.

## 2026-07-04 Sync is wired app-wide in the root layout

**Context.** Publish and fold were wired only in `/dev`.

**Decision.** The root layout owns the publish hook. (#389)

**Why.** The shipping app never synced, and a partitioned dApp iframe learns
about a revoke no other way.

## 2026-07-03 The state pointer is a reserved-slot SOC

**Context.** The partition's state pointer was an epoch feed entry in a data
slot.

**Decision.** It is a reserved-slot SOC that overstamps the partition's
reserved slot, like the counter chunks.

**Why.** It consumes no data slot, so the snapshot has nothing to compensate
for.

## 2026-06-29 One kind of account, one nested document

**Context.** Accounts had distinct types (passkey, ethereum, agent), with flat
identity, app and stamp stores joined by pointers.

**Decision.** There is one BIP-39 seed account that owns its connected apps and
postage stamps inline. Access methods live in the device-local vault. (#377)

**Why.** The types were only different ways of protecting the seed.

## 2026-06-26 Device discovery is an append-only roster

**Context.** Devices shared one mutable registry document and one snapshot.

**Decision.** An append-only roster handles discovery, and each device
publishes its own state feed, folded on read.

**Why.** On a high-latency or caching gateway, read-merge-overwrite dropped a
peer's just-written entry.

## 2026-06-16 A release sentinel is generation-fenced

**Context.** A stale release could write a sentinel over a successor's claim.

**Decision.** The sentinel carries the generation of the claim it releases.
(#349)

**Why.** A fresh-generation sentinel reads back as a higher generation, which
is a false lost race and a spurious read-only session.

## 2026-06-12 The theme key is `swarm-id-theme`

**Context.** Earlier deployments auto-persisted the OS-resolved theme under
`swarm-ui-theme` on every first visit.

**Decision.** The preference lives under `swarm-id-theme`, and everyone starts
on `auto`.

**Why.** The old key's value cannot be told apart from an explicit user choice.
