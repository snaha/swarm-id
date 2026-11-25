------------------------------- MODULE ApaInd -------------------------------
(***************************************************************************)
(* Apalache harness for IndInv. TStop and Wait are symbolic: the solver    *)
(* picks any integers allowed by the constant predicate, so one run covers *)
(* every timing, not a few chosen values. See check.sh for the runs.       *)
(***************************************************************************)
EXTENDS IndInv, Integers

(* A clock advances `rmin` to `rmax` per tick. The wait is long enough when it outlasts the
   stop on the slowest clock against the fastest: RMin * Wait >= RMax * TStop,
   which is Wait >= TStop when every clock keeps time. *)
Params(devices, rmin, rmax, longWait, matchRound, resetOnContact, sessionAge, ackCheck) ==
  /\ Devices = devices
  /\ RMin = rmin
  /\ RMax = rmax
  /\ TStop \in Int
  /\ Wait \in Int
  /\ TStop >= 1
  /\ Wait >= 0
  /\ IF longWait THEN RMin * Wait >= RMax * TStop ELSE RMin * Wait < RMax * TStop
  /\ MaxRound = 3
  /\ MatchRound = matchRound
  /\ ResetOnContact = resetOnContact
  /\ SessionAge = sessionAge
  /\ Stall = TRUE
  /\ AckCheck = ackCheck

\* Drift: one clock up to a third faster than another, which is what
\* LEASE_WAIT_MS / LEASE_STOP_MS = 8000 / 6000 allows.

Two == Params({1, 2}, 1, 1, TRUE, TRUE, TRUE, TRUE, TRUE)
Three == Params({1, 2, 3}, 1, 1, TRUE, TRUE, TRUE, TRUE, TRUE)
Four == Params({1, 2, 3, 4}, 1, 1, TRUE, TRUE, TRUE, TRUE, TRUE)
TwoDrift == Params({1, 2}, 3, 4, TRUE, TRUE, TRUE, TRUE, TRUE)
ThreeDrift == Params({1, 2, 3}, 3, 4, TRUE, TRUE, TRUE, TRUE, TRUE)
\* Each breaks one rule; the invariant must then stop being inductive.
ShortWait == Params({1, 2}, 1, 1, FALSE, TRUE, TRUE, TRUE, TRUE)
ShortWaitDrift == Params({1, 2}, 3, 4, FALSE, TRUE, TRUE, TRUE, TRUE)
NoRoundMatch == Params({1, 2}, 1, 1, TRUE, FALSE, TRUE, TRUE, TRUE)
NoContactReset == Params({1, 2}, 1, 1, TRUE, TRUE, FALSE, TRUE, TRUE)
NoSessionAge == Params({1, 2}, 1, 1, TRUE, TRUE, TRUE, FALSE, TRUE)
NoAckCheck == Params({1, 2}, 1, 1, TRUE, TRUE, TRUE, TRUE, FALSE)

(* Any state at all that satisfies Inv. *)
IndInit ==
  /\ mode \in [Devices -> {"idle", "claiming", "holding"}]
  /\ link \in [Devices -> {"up", "down"}]
  /\ online \in [Devices -> BOOLEAN]
  /\ room \in SUBSET Devices
  /\ view \in [Devices -> SUBSET Devices]
  /\ since \in [Devices -> Int]
  \* flat, because Apalache cannot pick from [D -> [D -> Int]]
  /\ \E f \in [Devices \X Devices -> Int] :
       absent = [d \in Devices |-> [p \in Devices |-> f[<<d, p>>]]]
  /\ round \in [Devices -> 0..MaxRound]
  /\ acks \in [Devices -> SUBSET Devices]
  /\ msgs \in SUBSET Message
  /\ age \in [Devices -> Int]
  /\ changed \in [Devices -> SUBSET Devices]
  /\ writing \in [Devices -> 0..MaxRound]
  /\ overlap \in [Devices -> BOOLEAN]
  /\ Inv

\* Must FAIL: shows Inv admits holding states, so it is not vacuous.
NobodyPotent == \A d \in Devices : ~Potent(d)
=============================================================================
