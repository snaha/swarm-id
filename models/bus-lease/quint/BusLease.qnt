// -*- mode: Bluespec; -*-
//
// Quint version of BusLease.tla: mutual exclusion on one batch partition
// between devices that coordinate over the account bus, where a device without
// a live connection to the signaling server is read-only.
//
// See README.md for the protocol, what is and is not modelled, and how to run.
module BusLease {
  const Devices: Set[int] // device ids; the lower id wins a tie
  const TStop: int // ticks without a heartbeat after which a device stops writing
  const Wait: int // ticks a peer must be seen absent before it is ignored
  const MaxRound: int // claim rounds per device (bounds the model)
  const MatchRound: bool // an answer counts only for the claim round it answers
  const ResetOnContact: bool // hearing from a peer restarts its absence timer

  // kind is "claim" or "free"
  type Message = { kind: str, from: int, to: int, r: int }

  var mode: int -> str // "idle" (read-only), "claiming" or "holding"
  var link: int -> bool // whether the device's socket to the server really works
  var online: int -> bool // whether the device believes it has a socket
  var room: Set[int] // devices the server believes are connected
  var view: int -> Set[int] // the room as last reported to each device
  var since: int -> int // ticks since the device's last heartbeat round trip
  var absent: int -> (int -> int) // ticks a device has seen a peer absent
  var round: int -> int // number of the device's current claim round
  var acks: int -> Set[int] // peers that answered "free" in the current round
  var msgs: Set[Message] // messages in flight between devices

  pure def min(a: int, b: int): int = if (a < b) a else b

  def others(d: int): Set[int] = Devices.exclude(Set(d))

  // A device may stamp only while it holds and has heard from the server
  // within the last TStop ticks.
  def holds(d: int): bool = mode.get(d) == "holding" and since.get(d) < TStop

  def claimsFrom(d: int, r: int): Set[Message] =
    others(d).map(p => { kind: "claim", from: d, to: p, r: r })

  def reply(m: Message, kind: str): Message =
    { kind: kind, from: m.to, to: m.from, r: m.r }

  // The absence timers after device p hears from device c.
  def heard(p: int, c: int): int -> (int -> int) =
    if (ResetOnContact) absent.setBy(p, row => row.set(c, 0)) else absent

  // Frame conditions: groups of variables an action leaves unchanged.
  action keepConnection = all {
    link' = link,
    online' = online,
    room' = room,
    view' = view,
  }

  action keepClaim = all {
    mode' = mode,
    round' = round,
    acks' = acks,
    msgs' = msgs,
  }

  action init = all {
    mode' = Devices.mapBy(d => "idle"),
    link' = Devices.mapBy(d => false),
    online' = Devices.mapBy(d => false),
    room' = Set(),
    view' = Devices.mapBy(d => Set()),
    since' = Devices.mapBy(d => 0),
    absent' = Devices.mapBy(d => Devices.mapBy(p => 0)),
    round' = Devices.mapBy(d => 0),
    acks' = Devices.mapBy(d => Set()),
    msgs' = Set(),
  }

  // --- Connection to the signaling server ---

  // A device opens a new socket. The server reports the room to it, and
  // reports the newcomer to every device whose socket works.
  action join(d: int): bool = all {
    not(online.get(d)),
    not(link.get(d)),
    link' = link.set(d, true),
    online' = online.set(d, true),
    room' = room.union(Set(d)),
    view' = Devices.mapBy(e =>
      if (e == d) room.union(Set(d))
      else if (link.get(e)) view.get(e).union(Set(d))
      else view.get(e)
    ),
    since' = since.set(d, 0),
    absent' = Devices.mapBy(e => Devices.mapBy(p =>
      if (e == d) 0
      else if (p == d and link.get(e)) 0
      else absent.get(e).get(p)
    )),
    keepClaim,
  }

  // The socket dies. Neither side knows yet.
  action linkDown(d: int): bool = all {
    link.get(d),
    link' = link.set(d, false),
    online' = online,
    room' = room,
    view' = view,
    since' = since,
    absent' = absent,
    keepClaim,
  }

  // The server notices the dead socket and reports `peer-left`.
  action serverNotices(d: int): bool = all {
    not(link.get(d)),
    room.contains(d),
    room' = room.exclude(Set(d)),
    view' = Devices.mapBy(e =>
      if (link.get(e)) view.get(e).exclude(Set(d)) else view.get(e)
    ),
    link' = link,
    online' = online,
    since' = since,
    absent' = absent,
    keepClaim,
  }

  // The device notices the dead socket and goes read-only.
  action deviceNotices(d: int): bool = all {
    online.get(d),
    not(link.get(d)),
    online' = online.set(d, false),
    mode' = mode.set(d, "idle"),
    acks' = acks.set(d, Set()),
    link' = link,
    room' = room,
    view' = view,
    since' = since,
    absent' = absent,
    round' = round,
    msgs' = msgs,
  }

  // A heartbeat round trip with the server. A holder whose last one was too
  // old did not write meanwhile, and writes again from here: it stayed in the
  // room, and a claim it was handed in that time ended its hold (handleClaim).
  action heartbeat(d: int): bool = all {
    online.get(d),
    link.get(d),
    room.contains(d),
    since' = since.set(d, 0),
    mode' = mode,
    acks' = acks,
    keepConnection,
    absent' = absent,
    round' = round,
    msgs' = msgs,
  }

  // One tick of every device's clock.
  action tick = all {
    since' = Devices.mapBy(d => min(since.get(d) + 1, TStop)),
    absent' = Devices.mapBy(d => Devices.mapBy(p =>
      if (p != d and online.get(d) and not(view.get(d).contains(p)))
        min(absent.get(d).get(p) + 1, Wait)
      else absent.get(d).get(p)
    )),
    keepConnection,
    keepClaim,
  }

  // --- Claiming ---

  action startClaim(d: int): bool = all {
    online.get(d),
    mode.get(d) == "idle",
    since.get(d) < TStop,
    round.get(d) < MaxRound,
    round' = round.set(d, round.get(d) + 1),
    mode' = mode.set(d, "claiming"),
    acks' = acks.set(d, Set()),
    msgs' = msgs.union(claimsFrom(d, round.get(d) + 1)),
    keepConnection,
    since' = since,
    absent' = absent,
  }

  // A device answers a claim. A sent message stays in `msgs` for good and may
  // be delivered at any later step, any number of times, or never; "never" is a
  // lost message, so no step removes one and no step sends a claim again. A
  // refusal is not a message because no rule reads it.
  action handleClaim(m: Message): bool = all {
    m.kind == "claim",
    absent' = heard(m.to, m.from),
    any {
      // not writing: free
      all {
        mode.get(m.to) == "idle" or (mode.get(m.to) == "holding" and not(holds(m.to))),
        mode' = mode.set(m.to, "idle"),
        acks' = acks.set(m.to, Set()),
        msgs' = msgs.union(Set(reply(m, "free"))),
      },
      // both claiming: the lower id wins
      all {
        mode.get(m.to) == "claiming",
        m.from < m.to,
        mode' = mode.set(m.to, "idle"),
        acks' = acks.set(m.to, Set()),
        msgs' = msgs.union(Set(reply(m, "free"))),
      },
      all {
        mode.get(m.to) == "claiming",
        not(m.from < m.to),
        mode' = mode,
        acks' = acks,
        msgs' = msgs,
      },
      // holding and busy: refuse
      all {
        holds(m.to),
        mode' = mode,
        acks' = acks,
        msgs' = msgs,
      },
      // holding and idle: hand over
      all {
        holds(m.to),
        mode' = mode.set(m.to, "idle"),
        acks' = acks,
        msgs' = msgs.union(Set(reply(m, "free"))),
      },
    },
    keepConnection,
    since' = since,
    round' = round,
  }

  action handleFree(m: Message): bool = all {
    m.kind == "free",
    mode.get(m.to) == "claiming",
    MatchRound implies m.r == round.get(m.to),
    acks' = acks.set(m.to, acks.get(m.to).union(Set(m.from))),
    absent' = heard(m.to, m.from),
    mode' = mode,
    round' = round,
    msgs' = msgs,
    keepConnection,
    since' = since,
  }

  // Every peer has either answered "free" in this round, or has been seen
  // absent from the room for Wait ticks.
  action acquire(d: int): bool = all {
    online.get(d),
    mode.get(d) == "claiming",
    since.get(d) < TStop,
    others(d).forall(p => acks.get(d).contains(p) or absent.get(d).get(p) >= Wait),
    mode' = mode.set(d, "holding"),
    round' = round,
    acks' = acks,
    msgs' = msgs,
    keepConnection,
    since' = since,
    absent' = absent,
  }

  // Stop holding, or give up a claim.
  action standDown(d: int): bool = all {
    mode.get(d) != "idle",
    mode' = mode.set(d, "idle"),
    acks' = acks.set(d, Set()),
    round' = round,
    msgs' = msgs,
    keepConnection,
    since' = since,
    absent' = absent,
  }

  action deviceStep = {
    nondet d = oneOf(Devices)
    any {
      join(d),
      linkDown(d),
      serverNotices(d),
      deviceNotices(d),
      heartbeat(d),
      startClaim(d),
      acquire(d),
      standDown(d),
    }
  }

  action messageStep = all {
    msgs != Set(),
    {
      nondet m = oneOf(msgs)
      any {
        handleClaim(m),
        handleFree(m),
      }
    },
  }

  action step = any {
    tick,
    deviceStep,
    messageStep,
  }

  // Safety: two devices never write on the partition at once.
  val exclusion = Devices.forall(a => Devices.forall(b =>
    a != b implies not(holds(a) and holds(b))
  ))

  // Not a requirement. Checking it as an invariant must FAIL, which shows that
  // holding is reachable and `exclusion` is not vacuously true.
  val nobodyEverHolds = Devices.forall(d => not(holds(d)))
}

// One module per configuration, matching the .cfg files of the TLA+ version.

module Safe {
  import BusLease(Devices = Set(1, 2), TStop = 2, Wait = 2, MaxRound = 2,
    MatchRound = true, ResetOnContact = true).*
}

module ShortWait {
  import BusLease(Devices = Set(1, 2), TStop = 2, Wait = 1, MaxRound = 2,
    MatchRound = true, ResetOnContact = true).*
}

module NoRoundMatch {
  import BusLease(Devices = Set(1, 2), TStop = 2, Wait = 2, MaxRound = 2,
    MatchRound = false, ResetOnContact = true).*
}

module NoContactReset {
  import BusLease(Devices = Set(1, 2), TStop = 2, Wait = 2, MaxRound = 2,
    MatchRound = true, ResetOnContact = false).*
}

// Three devices.

module Safe3 {
  import BusLease(Devices = Set(1, 2, 3), TStop = 2, Wait = 2, MaxRound = 2,
    MatchRound = true, ResetOnContact = true).*
}

module ShortWait3 {
  import BusLease(Devices = Set(1, 2, 3), TStop = 2, Wait = 1, MaxRound = 2,
    MatchRound = true, ResetOnContact = true).*
}
