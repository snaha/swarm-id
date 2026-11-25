------------------------------- MODULE IndInv -------------------------------
(***************************************************************************)
(* An inductive invariant for BusLease: it holds in Init, every step of    *)
(* Next keeps it, and it implies Exclusion. Checked by Apalache from every *)
(* state that satisfies it, not only the reachable ones (ApaInd.tla), so   *)
(* the result does not depend on how deep a search went.                   *)
(***************************************************************************)
EXTENDS BusLease

Up(d) == link[d] = "up"

\* d may write now, or again after a heartbeat on this session.
Alive(d) == since[d] < TStop \/ d \in room

\* Holding, and able to write now or later on the same session. Exclusion
\* is the special case of writing now; this is the form that is inductive,
\* because an overdue holder still in the room writes again after a heartbeat.
Potent(d) == mode[d] = "holding" /\ Alive(d)

Free(p, c, r) == [type |-> "free", from |-> p, to |-> c, r |-> r]
Claim(c, p, r) == [type |-> "claim", from |-> c, to |-> p, r |-> r]

(* What the room, the views and the counters say about each other. *)
Struct ==
  \A d \in Devices :
    \* a working socket sees the room exactly
    /\ Up(d) => online[d] /\ d \in room /\ view[d] = room /\ changed[d] = {}
    \* a stalled view is wrong only about the peers it has been told changed
    /\ online[d] /\ ~Up(d) =>
         \A p \in Others(d) : ((p \in view[d]) # (p \in room)) => p \in changed[d]
    /\ mode[d] # "idle" => online[d] /\ round[d] >= 1
    /\ SessionAge /\ mode[d] = "holding" => age[d] >= Wait
    \* a running absence timer means the peer really is out of view
    /\ \A p \in Others(d) : online[d] /\ absent[d][p] > 0 => p \notin view[d]
    /\ d \notin changed[d]
    /\ absent[d][d] = 0
    /\ online[d] => d \in view[d]

(* Every answer answers a claim that was sent; every ack is an answer. *)
Msgs ==
  /\ \A m \in msgs :
       /\ m.from # m.to
       /\ m.type = "claim" => 1 <= m.r /\ m.r <= round[m.from]
       /\ m.type = "free" => Claim(m.to, m.from, m.r) \in msgs
  /\ \A c \in Devices : mode[c] = "claiming" =>
       \A p \in acks[c] : p # c /\ Free(p, c, round[c]) \in msgs

(* b's absence timer for a is backed by a real absence of a: a is offline;
   or a left the room and has had no heartbeat for at least as long; or a
   joined while b's stream was stalled, so a's session is younger than b's
   own silence. *)
Fresh(b, a) ==
  \/ ~online[a]
  \/ a \notin room /\ ~Up(a) /\ since[a] >= Min(absent[b][a], TStop)
  \/ ~Up(b) /\ a \in changed[b] /\ Min(age[a], TStop) <= since[b]

Timers ==
  \A b \in Devices : \A a \in Others(b) :
    /\ online[b] /\ absent[b][a] > 0 => Fresh(b, a)
    \* a peer that joined during b's stall, and that b has not seen yet
    /\ online[b] /\ ~Up(b) /\ a \in changed[b] /\ a \notin view[b] /\ online[a]
         => Min(age[a], TStop) <= since[b]

(* c heard p's claim, which restarted c's timer for p (ResetOnContact): the
   timer has run no longer than c's own heartbeat silence, or p is gone from
   the room and silent at least as long. *)
HeardSince(c, p) ==
  \/ Min(absent[c][p], TStop) <= since[c]
  \/ p \notin room /\ ~Up(p) /\ since[p] >= Min(absent[c][p], TStop)

\* c answered "free" to p's current round, and p still claims or holds.
Answered(c, p) == mode[p] # "idle" /\ Free(c, p, round[p]) \in msgs

(* An answer stays true: c cannot use the time since against p, the two
   never answered each other's current rounds, and c does not hold while
   p can still take the lane on c's word. *)
Claims ==
  \A c, p \in Devices : c # p /\ Answered(c, p) =>
    /\ HeardSince(c, p)
    /\ ~Answered(p, c)
    /\ mode[p] = "claiming" /\ Alive(p) => ~Potent(c)

PotentExclusion == \A a, b \in Devices : a # b => ~(Potent(a) /\ Potent(b))

Core == Struct /\ Msgs /\ Timers /\ Claims /\ PotentExclusion

(* TypeOK with integer bounds written out, since Apalache needs constant
   ranges and TStop and Wait are symbolic there. *)
Bounds ==
  /\ mode \in [Devices -> {"idle", "claiming", "holding"}]
  /\ link \in [Devices -> {"up", "down"}]
  /\ room \subseteq Devices
  /\ msgs \subseteq Message
  /\ \A d \in Devices :
       /\ 0 <= since[d] /\ since[d] <= TStop
       /\ 0 <= age[d] /\ age[d] <= Wait
       /\ 0 <= round[d] /\ round[d] <= MaxRound
       /\ view[d] \subseteq Devices /\ acks[d] \subseteq Devices
       /\ changed[d] \subseteq Devices
       /\ \A p \in Devices : 0 <= absent[d][p] /\ absent[d][p] <= Wait

Inv == Bounds /\ Core

\* The invariant is strong enough: Holds implies Potent.
InvImpliesExclusion == Inv => Exclusion
=============================================================================
