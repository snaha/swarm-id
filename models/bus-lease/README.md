# Bus lease model

A TLA+ model of mutual exclusion on one batch partition when devices coordinate
over the account bus and a device without a live connection to the signaling
server is read-only. Background: [#1017](https://github.com/snaha/swarm-id/issues/1017).

**Status.** `Exclusion` is proved by an inductive invariant (`IndInv.tla`,
2026-11-25) for two, three and four devices, every `TStop >= 1` and every
`Wait >= TStop`; see "Proof by induction". The TLC searches under "Running it"
still run, as the counterexamples for the broken variants. `check.sh` runs
everything, and CI runs it when anything under `models/` changes.

## The protocol being modelled

- A device may write only while it holds the partition **and** has completed a
  heartbeat round trip with the signaling server within the last `TStop` ticks.
- To claim, a device asks every peer. It may take the partition when each peer
  has either answered "free" for this claim round, or has been absent from the
  server's room, as reported to the claimant, for `Wait` ticks.
- A claimant takes nothing before it has itself been in the room for `Wait`
  ticks (`SessionAge`, since 2026-11-18): it cannot have seen anyone absent
  for longer than that.
- Two devices claiming at once: the lower device id wins, the other stands down.
- A holder that is asked and is idle hands over; a busy one refuses.
- A holder whose heartbeat is overdue answers no claim, and writes again once
  the same connection completes one (since 2026-11-17).

The signaling server only reports who is connected. It grants nothing and
stores nothing.

## What can go wrong in the model

- A device's socket dies and the server, the device, or both notice late.
- A device's stream from the server stalls and comes back on the same
  connection (`Stall`, since 2026-11-18): it hears of everyone who joined or
  left meanwhile only then, while messages between devices still reach it.
  This is two tabs of one browser, which also talk over `BroadcastChannel`.
  It is the case that needs `ResetOnContact` on every path a lane message
  arrives by.
- Any message between devices is lost, delayed, reordered or delivered twice,
  over the relay or a WebRTC DataChannel, with or without a live server socket.
  A sent message stays deliverable for good and may be delivered at any later
  step or never; "never" is a lost message, so the spec has no step that
  removes a message or sends one again. A refusal is not a message, because no
  rule reads it. With those three as explicit steps the same check took
  77,321,799 states and 19 minutes.

Not modelled: Swarm (finding and publishing the utilization state), clocks that
run at different rates, a write in flight when a device stops, several tabs of
one device, and more than one partition.

In the implementation (`lib/src/sync/bus-lease.ts`) a "device" of the model is
one context: a tab or an iframe, for as long as its connection lasts. Tabs of
one browser are separate participants, and a context that reconnects is a new
one. Partitions are independent instances of the protocol.

## Running it

Needs Java and `tla2tools.jar` from the
[TLA+ releases](https://github.com/tlaplus/tlaplus/releases).

```bash
cd models/bus-lease
java -cp /path/to/tla2tools.jar tlc2.TLC -config Safe.cfg BusLease.tla
```

Or every check at once, each against the outcome it must have (about 3½
minutes; Apalache from its [releases](https://github.com/apalache-mc/apalache/releases)):

```bash
TLA2TOOLS=/path/to/tla2tools.jar APALACHE=/path/to/apalache/bin/apalache-mc ./check.sh
```

| Config               | Change from `Safe.cfg`                         | Result                                          |
| -------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `Safe.cfg`           | none: `Wait = TStop`, both checks on           | `Exclusion` holds: 1,168,225 states, depth 32   |
| `Reachable.cfg`      | checks `NobodyEverHolds` instead               | fails in 6 steps, as intended (holding happens) |
| `ShortWait.cfg`      | `Wait < TStop`                                 | `Exclusion` violated in 9 steps                 |
| `NoRoundMatch.cfg`   | a "free" answer counts for any claim round     | `Exclusion` violated in 15 steps                |
| `NoContactReset.cfg` | hearing from a peer does not restart its timer | `Exclusion` violated in 16 steps                |

All five finish within half a minute. The result covers two devices, `TStop = Wait = 2` and two
claim rounds per device, not larger sizes.

The three failing variants each remove one rule, to show that the rule is
needed and that the checker can find the fault.

## Proof by induction

`IndInv.tla` states an invariant `Inv` with three properties, which Apalache
checks (`ApaInd.tla`, `check.sh`):

- `Init` satisfies `Inv`;
- `Inv` implies `Exclusion`;
- from **any** state satisfying `Inv`, reachable or not, every step of `Next`
  leads to a state satisfying `Inv`.

Together they prove `Exclusion` for every run, however long, without
searching the runs. `TStop` and `Wait` are symbolic, so one check covers every
`TStop >= 1` with `Wait >= TStop`. Bounded are the devices (two and three in
CI, four with `FULL=1`, about 2 minutes) and the claim rounds (three: only
their equality matters to the protocol).

What `Inv` says, in short:

- **The views are honest.** A device with a working socket sees the room
  exactly; a stalled one is wrong only about peers it has been told changed;
  a running absence timer means the peer is out of view.
- **Absence timers are honest (`Fresh`).** If `b` has seen `a` absent for `k`
  ticks, then `a` is offline; or it left the room and has had no heartbeat
  for at least `k` ticks; or it joined while `b` was stalled, so its session
  is younger than `b`'s own silence.
- **Answers stay true (`Claims`).** If `c` answered "free" to `p`'s current
  round, `c`'s timer for `p` restarted then, so it cannot run to `Wait` while
  `c` can still write; the two did not both answer each other's current
  rounds; and `c` does not hold while `p` can still take the lane on its word.
- **No two potent holders (`PotentExclusion`).** No two devices are holding and
  able to write, now or after a heartbeat on the same session. An overdue
  holder still in the room counts, since it writes again after a heartbeat.

The variants that break one rule (`Wait < TStop`, no `MatchRound`, no
`ResetOnContact`, no `SessionAge`) each make `Inv` fail to be inductive.

The proof is of the model, not of `lib/src/sync/bus-lease.ts`.

## Three devices

`ShortWait3.cfg` (`Wait < TStop`, one claim round per device) is violated in
10 steps, within seconds (2026-11-23). The safe configuration (`Safe3.cfg`) is
much larger. With one claim round per device, TLC ran for 2 hours
on 10 cores (2026-11-13) and stopped at its time limit: 464 million distinct
states to depth 21, no violation, 162 million states still queued. So three
devices is a bounded check by TLC: every sequence of up to about 20 steps is
safe. The proof by induction above covers every sequence. The run wrote 56 GB of state files; point `-metadir` at a disk
with room.

## Names in the spec and what they stand for

| Spec                 | In the system                                                 |
| -------------------- | ------------------------------------------------------------- |
| `room`, `view`       | the signaling server's room and its `peer-joined`/`peer-left` |
| `link`, `online`     | whether a WebSocket works, and whether the device thinks so   |
| `Heartbeat`, `since` | a round trip with the server, and the time since the last one |
| `claim` / `free`     | `lane-claim`, `lane-free` on the bus                          |
| `round`              | a per-claim nonce                                             |
| `TStop`              | how long a holder may write without hearing from the server   |
| `Wait`               | how long a claimant waits after `peer-left`                   |
