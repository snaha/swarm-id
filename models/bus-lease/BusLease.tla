------------------------------ MODULE BusLease ------------------------------
(***************************************************************************)
(* Mutual exclusion on one batch partition between devices that coordinate *)
(* over the account bus, with the rule that a device without a live        *)
(* connection to the signaling server is read-only.                        *)
(*                                                                         *)
(* What is modelled                                                        *)
(*   - The signaling server: it knows which devices have a socket (`room`) *)
(*     and tells connected devices when one joins or leaves. It stores     *)
(*     nothing else and grants nothing.                                    *)
(*   - A device's socket can die without either side noticing at once.     *)
(*     The server notices at some later point; the device notices at some  *)
(*     later point, or when `TStop` ticks pass without a heartbeat.        *)
(*   - Claim messages between devices (relay or WebRTC DataChannel): any   *)
(*     message can be lost, delayed, reordered or delivered twice, and can *)
(*     arrive whether or not the server connection is alive.               *)
(*     A sent message stays in `msgs` for good and may be delivered at any *)
(*     later step, any number of times, or never. "Never" is a lost        *)
(*     message, so there is no separate step that removes one, and         *)
(*     sending a claim again would add nothing. A refusal is not a         *)
(*     message here because no rule reads it.                              *)
(*   - Time as ticks. Each tick, every device's clock advances by its own  *)
(*     amount between RMin and RMax: clocks that run at different rates,   *)
(*     and not at a steady one.                                            *)
(*   - Writes that take time: one starts while its device holds, and the   *)
(*     device may acknowledge it only if it still holds, in the same claim *)
(*     round, when it ends (`commit()` in batch-write-coordinator.ts).      *)
(*                                                                         *)
(* What is not modelled                                                    *)
(*   - Swarm: finding and publishing the utilization state.                *)
(*   - Several tabs of one device (one device is one process here).        *)
(*   - More than one partition (exclusion is per partition).               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  \* @type: Set(Int);
  Devices,        \* device ids, a set of naturals; the lower id wins a tie
  \* @type: Int;
  TStop,          \* ticks without a heartbeat after which a device stops writing
  \* @type: Int;
  Wait,           \* ticks a peer must be seen absent before it is ignored
  \* @type: Int;
  MaxRound,       \* claim rounds per device (bounds the model)
  \* @type: Bool;
  MatchRound,     \* TRUE: an answer counts only for the claim round it answers
  \* @type: Bool;
  ResetOnContact, \* TRUE: hearing from a peer restarts its absence timer
  \* @type: Bool;
  SessionAge,     \* TRUE: acquire only once this session is Wait ticks old
  \* @type: Bool;
  Stall,          \* TRUE: a down link may come back on the same session
  \* @type: Int;
  RMin,           \* least a device's clock advances in one tick
  \* @type: Int;
  RMax,           \* most a device's clock advances in one tick
  \* @type: Bool;
  AckCheck        \* TRUE: a write is acknowledged only if it still Holds

ASSUME /\ Devices \subseteq Nat
       /\ TStop \in Nat \ {0}
       /\ Wait \in Nat
       /\ MaxRound \in Nat
       /\ MatchRound \in BOOLEAN
       /\ ResetOnContact \in BOOLEAN
       /\ RMin \in Nat \ {0}
       /\ RMax \in Nat
       /\ RMin <= RMax

VARIABLES
  \* @type: Int -> Str;
  mode,    \* per device: "idle" (read-only), "claiming" or "holding"
  \* @type: Int -> Str;
  link,    \* per device: whether its socket to the server really works
  \* @type: Int -> Bool;
  online,  \* per device: whether the device believes it has a socket
  \* @type: Set(Int);
  room,    \* devices the server believes are connected
  \* @type: Int -> Set(Int);
  view,    \* per device: the room as last reported to it
  \* @type: Int -> Int;
  since,   \* per device: ticks since its last heartbeat round trip
  \* @type: Int -> (Int -> Int);
  absent,  \* per device and peer: ticks the device has seen the peer absent
  \* @type: Int -> Int;
  round,   \* per device: number of its current claim round
  \* @type: Int -> Set(Int);
  acks,    \* per device: peers that answered "free" in the current round
  \* @type: Set({type: Str, from: Int, to: Int, r: Int});
  msgs,    \* messages in flight between devices
  \* @type: Int -> Int;
  age,     \* per device: ticks since its Join (session age)
  \* @type: Int -> Set(Int);
  changed, \* per device: peers that joined or left while its stream was stalled
  \* @type: Int -> Int;
  writing, \* per device: the claim round its write in flight began in, or 0
  \* @type: Int -> Bool;
  overlap  \* per device: another device held during its write in flight

vars == <<mode, link, online, room, view, since, absent, round, acks, msgs, age, changed,
          writing, overlap>>

Others(d) == Devices \ {d}

Min(a, b) == IF a < b THEN a ELSE b

Message == [type : {"claim", "free"},
            from : Devices, to : Devices, r : 0..MaxRound]

TypeOK ==
  /\ mode \in [Devices -> {"idle", "claiming", "holding"}]
  /\ link \in [Devices -> {"up", "down"}]
  /\ online \in [Devices -> BOOLEAN]
  /\ room \subseteq Devices
  /\ view \in [Devices -> SUBSET Devices]
  /\ since \in [Devices -> 0..TStop]
  /\ absent \in [Devices -> [Devices -> 0..Wait]]
  /\ round \in [Devices -> 0..MaxRound]
  /\ acks \in [Devices -> SUBSET Devices]
  /\ msgs \subseteq Message

(* A device may stamp only while it holds and has heard from the server
   within the last TStop ticks. *)
Holds(d) == mode[d] = "holding" /\ since[d] < TStop

Init ==
  /\ mode = [d \in Devices |-> "idle"]
  /\ link = [d \in Devices |-> "down"]
  /\ online = [d \in Devices |-> FALSE]
  /\ room = {}
  /\ view = [d \in Devices |-> {}]
  /\ since = [d \in Devices |-> 0]
  /\ absent = [d \in Devices |-> [p \in Devices |-> 0]]
  /\ round = [d \in Devices |-> 0]
  /\ acks = [d \in Devices |-> {}]
  /\ msgs = {}
  /\ age = [d \in Devices |-> 0]
  /\ changed = [d \in Devices |-> {}]
  /\ writing = [d \in Devices |-> 0]
  /\ overlap = [d \in Devices |-> FALSE]

-----------------------------------------------------------------------------
(* Connection to the signaling server *)

(* A device opens a new socket. The server reports the room to it, and
   reports the newcomer to every device whose socket works. *)
Join(d) ==
  /\ ~online[d]
  /\ link[d] = "down"
  /\ link' = [link EXCEPT ![d] = "up"]
  /\ online' = [online EXCEPT ![d] = TRUE]
  /\ room' = room \cup {d}
  /\ view' = [e \in Devices |->
                IF e = d THEN room \cup {d}
                ELSE IF link[e] = "up" THEN view[e] \cup {d}
                ELSE view[e]]
  /\ since' = [since EXCEPT ![d] = 0]
  /\ absent' = [e \in Devices |-> [p \in Devices |->
                  IF e = d THEN 0
                  ELSE IF p = d /\ link[e] = "up" THEN 0
                  ELSE absent[e][p]]]
  /\ age' = [age EXCEPT ![d] = 0]
  /\ changed' = [e \in Devices |-> IF e = d THEN {} ELSE IF link[e] = "down" /\ online[e] THEN changed[e] \cup {d} ELSE changed[e]]
  /\ UNCHANGED <<mode, round, acks, msgs>>

(* The socket dies. Neither side knows yet. *)
LinkDown(d) ==
  /\ link[d] = "up"
  /\ link' = [link EXCEPT ![d] = "down"]
  /\ UNCHANGED <<mode, online, room, view, since, absent, round, acks, msgs>>

(* The server notices the dead socket and reports `peer-left`. *)
ServerNotices(d) ==
  /\ link[d] = "down"
  /\ d \in room
  /\ room' = room \ {d}
  /\ view' = [e \in Devices |->
                IF link[e] = "up" THEN view[e] \ {d} ELSE view[e]]
  /\ changed' = [e \in Devices |-> IF e # d /\ link[e] = "down" /\ online[e] THEN changed[e] \cup {d} ELSE changed[e]]
  /\ UNCHANGED <<mode, link, online, since, absent, round, acks, msgs>>

(* The device notices the dead socket and goes read-only. *)
DeviceNotices(d) ==
  /\ online[d]
  /\ link[d] = "down"
  /\ online' = [online EXCEPT ![d] = FALSE]
  /\ mode' = [mode EXCEPT ![d] = "idle"]
  /\ acks' = [acks EXCEPT ![d] = {}]
  /\ UNCHANGED <<link, room, view, since, absent, round, msgs>>


(* The server->device stream was only delayed, not dead: the device catches up
   on the room on the SAME session. Not in the original model, where a link
   that went down never comes back without a new Join. *)
Recover(d) ==
  /\ Stall
  /\ online[d]
  /\ link[d] = "down"
  /\ d \in room
  /\ link' = [link EXCEPT ![d] = "up"]
  /\ view' = [view EXCEPT ![d] = room]
  /\ absent' = [absent EXCEPT ![d] =
                  [p \in Devices |-> IF p \in changed[d] THEN 0 ELSE absent[d][p]]]
  /\ changed' = [changed EXCEPT ![d] = {}]
  /\ UNCHANGED <<mode, online, room, since, round, acks, msgs>>

(* A heartbeat round trip with the server. A holder whose last one was too
   old did not write meanwhile, and writes again from here: it stayed in the
   room and answered no claim in that time (HandleClaim). *)
Heartbeat(d) ==
  /\ online[d]
  /\ link[d] = "up"
  /\ d \in room
  /\ since' = [since EXCEPT ![d] = 0]
  /\ UNCHANGED <<mode, acks, link, online, room, view, absent, round, msgs>>

(* One tick of real time. Every device's clock advances by its own amount,
   anywhere from RMin to RMax, and all of its timers by that amount. *)
Tick ==
  \E step \in [Devices -> RMin..RMax] :
  /\ since' = [d \in Devices |-> Min(since[d] + step[d], TStop)]
  /\ absent' = [d \in Devices |-> [p \in Devices |->
                  IF p # d /\ online[d] /\ p \notin view[d]
                  THEN Min(absent[d][p] + step[d], Wait)
                  ELSE absent[d][p]]]
  /\ age' = [d \in Devices |-> Min(age[d] + step[d], Wait)]
  /\ UNCHANGED <<mode, link, online, room, view, round, acks, msgs>>

-----------------------------------------------------------------------------
(* Claiming *)

ClaimsFrom(d, r) ==
  {[type |-> "claim", from |-> d, to |-> p, r |-> r] : p \in Others(d)}

StartClaim(d) ==
  /\ online[d]
  /\ mode[d] = "idle"
  /\ since[d] < TStop
  /\ round[d] < MaxRound
  /\ round' = [round EXCEPT ![d] = @ + 1]
  /\ mode' = [mode EXCEPT ![d] = "claiming"]
  /\ acks' = [acks EXCEPT ![d] = {}]
  /\ msgs' = msgs \cup ClaimsFrom(d, round[d] + 1)
  /\ UNCHANGED <<link, online, room, view, since, absent>>

Heard(p, c) ==
  IF ResetOnContact
  THEN [absent EXCEPT ![p][c] = 0]
  ELSE absent

\* @type: ({type: Str, from: Int, to: Int, r: Int}, Str) => {type: Str, from: Int, to: Int, r: Int};
Reply(m, type) ==
  [type |-> type, from |-> m.to, to |-> m.from, r |-> m.r]

(* A device answers a claim. Delivery does not remove the message, so it
   can be delivered again. A refusal changes nothing but the absence timer. *)
HandleClaim(m) ==
  /\ m \in msgs
  /\ m.type = "claim"
  /\ LET p == m.to
         c == m.from
     IN
     /\ absent' = Heard(p, c)
     /\ \/ \* not writing: free
           /\ mode[p] = "idle"
           /\ msgs' = msgs \cup {Reply(m, "free")}
           /\ UNCHANGED <<mode, acks>>
        \/ \* holding, its heartbeat overdue: no answer
           /\ mode[p] = "holding" /\ ~Holds(p)
           /\ UNCHANGED <<mode, acks, msgs>>
        \/ \* both claiming: the lower id wins
           /\ mode[p] = "claiming"
           /\ IF c < p
              THEN /\ mode' = [mode EXCEPT ![p] = "idle"]
                   /\ acks' = [acks EXCEPT ![p] = {}]
                   /\ msgs' = msgs \cup {Reply(m, "free")}
              ELSE UNCHANGED <<mode, acks, msgs>>
        \/ \* holding and busy: refuse
           /\ Holds(p)
           /\ UNCHANGED <<mode, acks, msgs>>
        \/ \* holding and idle: hand over
           /\ Holds(p)
           /\ mode' = [mode EXCEPT ![p] = "idle"]
           /\ msgs' = msgs \cup {Reply(m, "free")}
           /\ UNCHANGED acks
  /\ UNCHANGED <<link, online, room, view, since, round>>

HandleFree(m) ==
  /\ m \in msgs
  /\ m.type = "free"
  /\ mode[m.to] = "claiming"
  /\ MatchRound => m.r = round[m.to]
  /\ acks' = [acks EXCEPT ![m.to] = @ \cup {m.from}]
  /\ absent' = Heard(m.to, m.from)
  /\ UNCHANGED <<mode, link, online, room, view, since, round, msgs>>

(* Every peer has either answered "free" in this round, or has been seen
   absent from the room for Wait ticks. *)
Acquire(d) ==
  /\ online[d]
  /\ mode[d] = "claiming"
  /\ since[d] < TStop
  /\ \A p \in Others(d) : p \in acks[d] \/ absent[d][p] >= Wait
  /\ (SessionAge => age[d] >= Wait)
  /\ mode' = [mode EXCEPT ![d] = "holding"]
  /\ UNCHANGED <<link, online, room, view, since, absent, round, acks, msgs>>

(* Stop holding, or give up a claim. *)
StandDown(d) ==
  /\ mode[d] # "idle"
  /\ mode' = [mode EXCEPT ![d] = "idle"]
  /\ acks' = [acks EXCEPT ![d] = {}]
  /\ UNCHANGED <<link, online, room, view, since, absent, round, msgs>>

-----------------------------------------------------------------------------
(* Writing *)

(* A write starts while its device may write, and takes any number of
   steps; `overlap` records whether another device held meanwhile. *)
WriteStart(d) ==
  /\ Holds(d)
  /\ writing[d] = 0
  /\ writing' = [writing EXCEPT ![d] = round[d]]

(* The write ends, acknowledged or failed: which, is `MayAck`. *)
WriteEnd(d) ==
  /\ writing[d] # 0
  /\ writing' = [writing EXCEPT ![d] = 0]

(* At its end, a write may be acknowledged if it began in this hold, and
   (AckCheck) the device still Holds. *)
MayAck(d) ==
  /\ writing[d] = round[d]
  /\ mode[d] = "holding"
  /\ AckCheck => Holds(d)

-----------------------------------------------------------------------------

Step ==
  \/ /\ UNCHANGED writing
     /\ \/ Tick /\ UNCHANGED changed
        \/ \E d \in Devices : Join(d)
        \/ /\ UNCHANGED age
           /\ \/ \E d \in Devices : ServerNotices(d) \/ Recover(d)
              \/ /\ UNCHANGED changed
                 /\ \/ \E d \in Devices :
                         \/ LinkDown(d) \/ DeviceNotices(d)
                         \/ Heartbeat(d) \/ StartClaim(d) \/ Acquire(d)
                         \/ StandDown(d)
                    \/ \E m \in msgs : HandleClaim(m) \/ HandleFree(m)
  \/ /\ \E d \in Devices : WriteStart(d) \/ WriteEnd(d)
     /\ UNCHANGED <<mode, link, online, room, view, since, absent, round, acks,
                    msgs, age, changed>>

HoldsAfter(e) == mode'[e] = "holding" /\ since'[e] < TStop

Next ==
  /\ Step
  /\ overlap' = [d \in Devices |->
       /\ writing'[d] # 0
       /\ \/ writing[d] # 0 /\ overlap[d]
          \/ \E e \in Others(d) : HoldsAfter(e)]

Spec == Init /\ [][Next]_vars

(* Safety: two devices never write on the partition at once. *)
Exclusion ==
  \A a, b \in Devices : a # b => ~(Holds(a) /\ Holds(b))

(* Safety of writes: a write that may be acknowledged had the lane to
   itself from start to end. *)
AckedExclusive == \A d \in Devices : MayAck(d) => ~overlap[d]

(* Not a requirement. Checking it as an invariant must FAIL, which shows
   that holding is reachable and Exclusion is not vacuously true. *)
NobodyEverHolds == \A d \in Devices : ~Holds(d)

=============================================================================
