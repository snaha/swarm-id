------------------------------- MODULE ApaInd -------------------------------
(***************************************************************************)
(* Apalache harness for IndInv. TStop and Wait are symbolic: the solver    *)
(* picks any integers allowed by the constant predicate, so one run covers *)
(* every timing, not a few chosen values. See check.sh for the runs.       *)
(***************************************************************************)
EXTENDS IndInv, Integers

Params(devices, longWait, matchRound, resetOnContact, sessionAge) ==
  /\ Devices = devices
  /\ TStop \in Int
  /\ Wait \in Int
  /\ TStop >= 1
  /\ Wait >= 0
  /\ IF longWait THEN Wait >= TStop ELSE Wait < TStop
  /\ MaxRound = 3
  /\ MatchRound = matchRound
  /\ ResetOnContact = resetOnContact
  /\ SessionAge = sessionAge
  /\ Stall = TRUE

Two == Params({1, 2}, TRUE, TRUE, TRUE, TRUE)
Three == Params({1, 2, 3}, TRUE, TRUE, TRUE, TRUE)
Four == Params({1, 2, 3, 4}, TRUE, TRUE, TRUE, TRUE)
\* Each breaks one rule; the invariant must then stop being inductive.
ShortWait == Params({1, 2}, FALSE, TRUE, TRUE, TRUE)
NoRoundMatch == Params({1, 2}, TRUE, FALSE, TRUE, TRUE)
NoContactReset == Params({1, 2}, TRUE, TRUE, FALSE, TRUE)
NoSessionAge == Params({1, 2}, TRUE, TRUE, TRUE, FALSE)

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
  /\ Inv

\* Must FAIL: shows Inv admits holding states, so it is not vacuous.
NobodyPotent == \A d \in Devices : ~Potent(d)
=============================================================================
