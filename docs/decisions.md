# Decisions

Architecture and product decisions, newest first. One entry per decision: the
context in a line or two, the decision, and why. Append only; a reversed
decision gets a new entry that names the old one. Code comments describe the
present and may point at an issue or PR; the reasons live here.

A PR that makes or changes a decision adds the entry in the same PR.

## 2026-11-23 The bus lease has one model, in TLA+

**Context.** `models/bus-lease` held the model twice, in TLA+ and in Quint. The Quint copy
had fallen behind: it lacked `SessionAge` and `Stall`, and its results predated them.

**Decision.** The Quint copy is deleted. `BusLease.tla` is the model, checked with TLC; the
three-device broken variant that existed only in Quint is `ShortWait3.cfg`.

**Why.** The only Quint backend that finished on this model was TLC, with the same
violations and state counts, so the copy was no second opinion, only a second text to keep
in step by hand. Two models that drift each cover rules the other does not, and neither
then says the protocol as a whole is safe.

## 2026-11-23 A lane message goes through the server, never a DataChannel

**Context.** The signaling transport delivers per peer over that peer's DataChannel when it
reads open, else through the server. A channel reads open for a while after its path has
died, and a message sent on it then is lost without an error, so a claim or its answer
could vanish and the claimant waited out the whole absence window.

**Decision.** `lane-claim`, `lane-free` and `lane-held` are always sent as `relay` frames.
Everything else keeps using the channel.

**Why.** A lane's liveness is measured on the server connection, so that is the path its
messages should share: either both work or the context is not confirmed. Lane traffic was
already sized for contexts with no channel at all, and answers go to the claimant alone,
so the server's message budget holds.

## 2026-11-18 An entry a context knows of is never taken for absent

**Context.** Bee answers `404`, or `500 read chunk failed`, for a retrieval that failed for
other reasons too (a deadline, no peer to ask), and goes on doing so for that chunk for a
while. A lane is taken again exactly when connectivity has just changed. Two such answers
for the newest pointer entry made a holder resume from an older entry, or from zero, and
stamp over uploads it had acknowledged itself.

**Decision.** A lookup that ends below an entry known to have been published is unsettled:
the context does not resume and does not publish. Known means read or written by this
context in this session, or remembered by the browser from an earlier one (IndexedDB). The
remembered entry is still only a hint for where to search: when it is gone and the search
from nothing ends at or above it, that result is used.

**Why.** Entries are only added, so the newest is never below one that existed; a lookup
that says otherwise is a misread. The test is the result, not whether the known entry is
still there, because a later entry can replace one that is off its search path
(`state-pointer-search.ts`): a device that comes back after others published would
otherwise find its remembered entry gone and never write again. What this costs: a browser
that remembers an entry of a batch whose entries are all gone (a local chain reset that
reissues the batch id) cannot write that partition until its local data is cleared. A
format change is not that case, the store's version bump drops what was remembered.

## 2026-11-18 A room is one protocol version, and the server holds every member to its ticks

**Context.** A claimant waits for every member of its room. A page left open on a build
that answers no lane claim sat in the same room and blocked every lane of its account. The
server was also told to keep a member that never pinged, so that such a page was not
dropped and reconnected every ten seconds, which kept it in the room for good.

**Decision.** The room topic's label names the room's protocol (`bus-context.ts`), and a
build whose members must answer lane claims is `v2`. The server drops any member that
leaves `MAX_SILENT_TICKS` ticks unanswered, with no exemption.

**Why.** A room in which one member cannot be waited for is a room in which nothing can be
taken. A page on an older build keeps syncing with its own kind in the `v1` room; the
server reconnects it every ten seconds there, which costs a handshake and breaks nothing
that worked. Before `1.0` there is nobody to keep (`AGENTS.md`).

## 2026-11-18 A signaling server is required to write a shared drive

**Context.** A context with no confirmed connection to the account's other devices cannot
ask for a lane. A build with no signaling URL, or one whose server was unreachable, waited
thirty seconds and failed with "all slots are held by other devices", while `canUpload`
stayed true and the self-hosting page called the server optional.

**Decision.** There is no fallback to writing alone. A build with no signaling URL reports
`canUpload: false` with `uploadUnavailableReason: no-account-bus` for a split batch, and a
write that could not ask fails as `upload-unavailable` with that reason
(`AccountBusUnavailableError`).

**Why.** Writing without asking is what the lanes exist to prevent: a second device of the
account may be writing the same partition, and nothing on Swarm says so. A subsidised
gateway, where one is configured, is still the fallback, as for any other reason.

## 2026-11-18 Only Bee's own answer makes a pointer entry absent

**Context.** The search for the newest state-pointer entry read any failure but its own
timeout as "this entry does not exist". A dropped connection, a rate limit or a proxy's
502 on one read made a lane resume from zero or from an older entry, and the slots of
acknowledged uploads were issued again.

**Decision.** An entry is absent when Bee says so: `404`, or `500` with Bee's message
`read chunk failed`. Every other failure leaves the entry unsettled, the lookup is
inconclusive, and the lane is not written (`isChunkAbsent`).

**Why.** The `500` is included because it is how Bee reports a chunk nobody has when the
node asked is itself the closest to the address and has no peer to ask (`no peer found`):
always on the four-node local cluster, and occasionally on a real node. Treating it as
unsettled would make a fresh partition untakeable there. Its cost: a node that is the
closest and has not yet received an entry published elsewhere reads it as absent, as it
would with a `404`.

## 2026-11-18 An upload is acknowledged under the hold it began with

**Context.** The coordinator checked that some lane was held before it published an
upload's counter, and not after. An upload was acknowledged when its connection was
replaced or its write path rebuilt (a top-up, a dilute) while the publish ran, and when its
lane was lost and taken again while it uploaded: the new hold starts from the published
counter, which knows nothing of the first upload's stamps.

**Decision.** Each bind and each loss of the bound lane is a hold of its own. An upload
remembers the hold it began with, and is acknowledged only if that hold stands before the
publish and after it. The publish asks once more just before it writes the pointer entry.

**Why.** The pointer entry is the one write the next holder acts on. An entry written
after the lane went can land after the next holder read the lane, which then resumes below
an acknowledged upload. The window that remains is the pointer upload itself, inside the
two seconds between `LEASE_STOP_MS` and `LEASE_WAIT_MS`, and an upload caught in it is
reported failed.

## 2026-11-18 A lane message counts its sender as present, on every path

**Context.** Hearing from a peer the room view does not contain restarts that peer's
absence clock (`ResetOnContact` in `models/bus-lease`). The rule was applied only where the
transport names the sender. `BroadcastChannel` names none, so a tab whose stream from the
server had stalled for a moment answered a claim from another tab of the same browser,
still saw the room as empty, and took the lane the other tab then took too.

**Decision.** A lane message says who sent it, and that sender is noted on every transport
whichever path the message came by. An answer of "held" withdraws the sender's earlier
"free". Answers go to the claimant alone, and a context that stood down for a lower id
does not ask again before its next confirmation.

**Why.** The model had no stream that stalls and recovers on the same connection: its room
view moved in step with the server. With that added (`Stall`), `Exclusion` holds only with
the reset on every path (1,168,225 states) and `NoContactReset.cfg` shows the two-tab
trace. The last two rules are about load, not safety: answers sent to the whole room and
losers asking again within 250 ms passed the server's message budget from about six
contexts on the relay, and the server then disconnected holders.

## 2026-11-18 The account sync writes no counter rows to Swarm

**Context.** After its upload the SwarmID tab's sync wrote the changed rows of the local
counter cache to Swarm, through a stamper bound to no lane. Those stamps went to partition
0's reserved slot whoever held that lane, and could land on another device's published
state. Nothing read the rows back.

**Decision.** The rows are not written. The counters travel as the lane's published state
(`partition-state.ts`), and a chunk stamped at a reserved slot names the slot.

**Why.** A second copy nobody reads bought nothing and put the copy that is read at risk.

## 2026-11-18 Open: a signaling deploy that overlaps

The signaling server closes every connection on `SIGTERM`, so a context is not left
confirmed by an instance that is being replaced. What is not decided: while the platform
runs the old and the new instance side by side, a context that joins the new one sees an
empty room and may take a lane after `LEASE_WAIT_MS` that a context on the old instance
still holds. Closing it needs the new instance to answer no ping for longer than the
overlap, which stops every write for that long after each deploy. The same holds for one
account reached through two signaling URLs (a signaling PR's preview and the `main` build
share an origin and storage, and sit in different rooms).

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

## 2026-11-17 The local counter cache has one layout for every depth

**Context.** The IndexedDB rows were uint16 up to depth 31 and uint32 above. A dilute from
31 to 32 read the old rows under the new layout and got zeros (#463).

**Decision.** Rows are always uint32: 64 rows of 1024 counters. The cache version is bumped,
which drops existing rows; they re-derive on next use.

**Why.** Deleting the switch removes the crossing, where invalidating the cache at dilute
time would only handle it, and every device would have to notice the dilute. The cost is
128 KB more per batch in IndexedDB below depth 32.

## 2026-11-17 A late confirmation does not end a hold

**Context.** A holder that went `LEASE_STOP_MS` without a confirmed round trip with the
signaling server dropped its lane when the confirmation did arrive, and had to wait
`LEASE_WAIT_MS` to take it again. A tab whose main thread was busy for six seconds (an
upload preparing its chunks) lost its lane with nobody else asking for it.

**Decision.** An overdue holder still may not stamp, and leaves claims unanswered (a
starved tab wakes to the queued claims before the server's answer, and "free" there gave
the lane away). Once the same connection is confirmed again it carries on; a write or a
stamp that finds the confirmation overdue waits for it. A new connection holds nothing,
as before.

**Why.** A claimant takes a lane only from "free" answers and from peers absent from the
room for `LEASE_WAIT_MS`. A holder on the same connection was never absent, so only its own
"free" can have given the lane away. `models/bus-lease` holds `Exclusion` with this
(421,149 states).

## 2026-11-17 Partition state is published as SBU1 leaves, with no depth on the wire

**Context.** The counter was serialized as fixed uint16 or uint32 chunks chosen
from the batch depth: 32 or 64 chunks, all of which a spread-out upload
rewrote, and a layout that changed when a dilute crossed depth 31 to 32
(#463). #918 fixed this on the lock-based stack, which is not continued.

**Decision.** Taken over from #918: the counters are packed with the leaf
encoding of Nectar's SBU1 usage snapshot, a frame (base and bit width) chosen
per publish from the counters' spread, deltas packed to that width, outliers
as exceptions. The frame rides in the reference chunk under topic domain `v2`.
State under `v1` is not read. Not taken over: #918's changes to the local
cache rows, which were built for tabs sharing one partition. The holder keeps
its publish baseline in memory instead, as exactly the counter it last read or
published.

**Why.** Nothing published depends on the depth, and a takeover reads 8–24
chunks instead of 33 or 65. Not reading `v1` means a lane's first take under
`v2` resumes from zero; accepted while the version is `0.x`. The widest delta
is 23 bits, so that the frame, 128 exceptions and a reference per leaf fit one
chunk. The baseline lives in memory because each tab now holds its partition
alone and reads the published counter when it takes one, so there are no
shared rows to certify. The cache rows still depend on the depth, so a dilute
across 31 to 32 on a live drive is not handled by this change.

## 2026-11-17 Each tab holds a partition for itself

**Context.** The bus lease was decided with "several tabs of one device keep
coordinating as they do" (2026-11-16): tabs shared a held partition through a
record in local storage, and a reloaded tab took it up again at once. Wiring
the protocol showed this does not fit it. The model's participant is one
process with one connection, and its safety rests on a participant that
reconnects holding nothing. A tab that reconnects and reads the device's hold
from a shared record holds again without asking, while another device that
saw every tab of this one gone for the wait has taken the partition: both
write.

**Decision.** Every context (a tab, an iframe) is its own participant, named
by its current connection to the signaling server. It asks for a partition
like any other context and is handed one by whoever holds it and is not
writing, a tab of the same browser included. The local lease record and the
take-up on reload are removed. A new or reloaded context waits until it has
been in the room for 8 s before it writes. This reverses the tab sentence of
the 2026-11-16 entry and may be revisited.

**Why.** It is the protocol exactly as checked, with no state shared between
contexts to get wrong. The cost is the wait on every page load, and that two
tabs of one browser hand a partition back and forth when both write and the
other partition is taken. Sharing between tabs would need the model extended
with tabs first; one way is a single tab per browser speaking for the others,
which keeps the sharing but adds a hand-off when that tab closes. Revisit if
the wait or the hand-offs between tabs show up in use.

## 2026-11-17 Nothing on Swarm says who holds a partition

**Context.** With the lease on the bus (2026-11-16) and the state pointer
found by search (below), the lock chunk and the intent and occupancy beacons
have no reader left.

**Decision.** They are removed, with the refresh timer, the idle release, the
release sentinel and the lease messages that sped them up. A claim first asks
whether a partition is held at all, and only then asks a holder to hand over,
so a newcomer takes a free partition before it disturbs anyone. The signaling
server drops a room member that stops answering its ticks. A process without
a bus (a script, a test) cannot write a partitioned batch.

**Why.** Each removed piece was a write to a fixed address read through
caches, or a timer covering for one. Removing the beacons also closes the gap
the entry below left open: nothing is written to the reserved slot any more
that the publish cannot steer away from the pointer entries. A member that
answers nothing must go because a claimant waits for everyone present, and a
frozen tab's browser keeps its socket open.

## 2026-11-17 The state pointer is a numbered, write-once entry found by search

**Context.** The partition's state pointer was written at an address derived
from the current 30-second window and rewritten there by every publish and
every refresh tick. A taking-over device found it through the lock chunk's
`leasedUntil`. Rewriting an address is what proved unreliable for the lock
(#1017): a deferred upload loses the new content and a node that cached the
old content keeps serving it. The lock chunk is also going away (the partition
lease moves to the account bus), and its timestamp with it.

**Decision.** Each publish writes the pointer as the next numbered entry, at
an address computed from the number, and no address is written twice. A reader
searches for the highest number: the powers of 8, then 8-way splits. It starts
from the last entry the device knows, kept with the stamper's synced
reference. The search is fixed, so the entries any later search depends on are
a small computable set, and the writer keeps every chunk it places in the
reserved slot out of their buckets. An idle holder writes nothing. A holder
that does not know the newest entry for sure searches before it publishes. A
search with an unsettled read above its answer fails safe, also on a partition
nothing was published on.

**Why.** A fresh address per publish has no older version for a cache to
serve, and the lookup needs neither a clock nor the lock. Numbers and not
timestamps, because two devices whose clocks differ by more than a publish
interval would order states wrongly. The entries stay in the reserved slot and
do not move to a data slot, because a data slot would spend drive capacity on
every publish and wrap away on a scratch drive. The price is that a later
reserved-slot write can replace an entry, which is why the search must be
fixed and its entries protected. Measured on the public gateway, a read of an
absent chunk answers in about half a second, so the usual lookup is one such
round and a cold one over 10,000 entries about eight. Not solved here: the
intent and occupancy beacons sit at fixed addresses in the same slot and can
still replace an entry, until the bus lease removes them.

## 2026-11-16 A transport answers two liveness questions, at the server's pace

**Context.** The bus lease (next entry) needs to know whether this context's
own connection works and whether another device is gone. The signaling server
is the first service to answer that; Swarm's pub/sub (BPS, bee#5626, SWIP-60)
is a likely second, and it has no join or leave notices and no acknowledgement
of a publish.

**Decision.** A transport that crosses devices answers `confirmedAgoMs()` and
`absentExceptMs(deviceIds)`: how recently this context's connection was
confirmed, and for how long nobody but the named devices has been present.
The lease asks nothing else about liveness. Both must come from one
authority: a device shown absent over a span had no confirmation within it.
The second question is asked about everyone outside a set, so that a device
this context has never heard of counts too. On the signaling server the confirmation is a
`ping`/`pong` round trip, timed from when the ping was sent, and the server
asks for one with a `tick` every 2 s.

**Why.** `peer-left` is a fact about sockets on one server; a contract in its
terms could not be met by a broker that reports no departures. Stated as two
durations, the signaling server meets it from its room and BPS can meet it
from a context's own messages coming back in the broker's order. The server
sets the pace because a hidden page's timers are throttled to about one a
minute while its message events are not, and a holder that cannot confirm its
connection stops writing.

## 2026-11-16 The signaling server is a single instance

**Context.** With the lease on the bus, the server's room is what says a
device is absent.

**Decision.** One instance serves all rooms. If it is ever scaled out, an
account is routed to one instance by a value derived from its key.

**Why.** Two instances with a room each for one account would show two devices
each other's absence, and both could hold the same partition.

## 2026-11-16 The partition lease is held over the account bus

**Context.** The lease was a lock chunk overwritten in place on Swarm. That
depends on several Bee behaviours holding at once: uploads being direct, no
node or cache serving an older copy, a header browsers may not send (#1016,
#1017). A stack of PRs built further on it (#918 to #1007).

**Decision.** Devices agree on who holds a partition over the account bus,
following the protocol checked in `models/bus-lease`. A context writes only
while it holds the partition and its connection was confirmed recently; one
that cannot reach the signaling server is read-only. A context waits after
joining before it may treat a device it has not seen as absent; the starting
values are a 2 s tick and a 6 s limit on an unconfirmed holder, which makes
that wait 6 to 8 s. Several tabs of one device keep coordinating as they do.
The utilization state stays on Swarm, at a new address on each publish. The
stack is not continued: the work starts from `main` and takes from the stack
only what does not depend on the lock chunk.

**Why.** Mutual exclusion needs one answer to "who is here", and a chunk read
through caches does not give one. The wait is paid once per page load and
starts when the proxy loads, so it is mostly over before the first upload.
Read-only without the server is the simple rule, and the one the model was
checked with.

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
