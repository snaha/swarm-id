#!/usr/bin/env bash
# Every check of the bus lease model, each against the outcome it must have.
#
#   TLA2TOOLS=/path/to/tla2tools.jar APALACHE=/path/to/apalache-mc ./check.sh
#
# Add FULL=1 for the four-device induction (about 2 minutes on its own).
set -uo pipefail
cd "$(dirname "$0")"

: "${TLA2TOOLS:?set TLA2TOOLS to tla2tools.jar}"
: "${APALACHE:?set APALACHE to the apalache-mc script}"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
failures=0

# expect <pass|fail> <name> <command...>
expect() {
  local want=$1 name=$2
  shift 2
  local start=$SECONDS
  "$@" >"$out/$name.log" 2>&1
  local code=$?
  local got=pass
  # 12 is a violated invariant for both tools; anything else is a broken run.
  if [ $code -eq 12 ]; then got=fail; elif [ $code -ne 0 ]; then got=error; fi
  if [ "$got" = "$want" ]; then
    printf 'ok    %-28s %s as expected (%ss)\n' "$name" "$got" $((SECONDS - start))
  else
    printf 'FAIL  %-28s wanted %s, got %s\n' "$name" "$want" "$got"
    tail -30 "$out/$name.log"
    failures=$((failures + 1))
  fi
}

tlc() { java -XX:+UseParallelGC -cp "$TLA2TOOLS" tlc2.TLC -workers auto \
  -metadir "$out/tlc-$1" -config "$1.cfg" BusLease.tla; }

# One step from any state satisfying Inv, under the constants `$1`.
induct() { "$APALACHE" check --out-dir="$out/apa" --cinit="$1" --init=IndInit \
  --next=Next --inv="${2:-Inv}" --length=1 ApaInd.tla; }

# Breadth-first search of the reachable states, as in the README's table.
expect pass Safe tlc Safe
expect fail Reachable tlc Reachable
expect fail ShortWait tlc ShortWait
expect fail NoRoundMatch tlc NoRoundMatch
expect fail NoContactReset tlc NoContactReset
expect fail ShortWait3 tlc ShortWait3

# Induction: Init satisfies Inv, Inv implies Exclusion, Next keeps Inv.
expect pass base-case "$APALACHE" check --out-dir="$out/apa" --cinit=Two \
  --init=Init --inv=Inv --length=0 ApaInd.tla
expect pass strong-enough "$APALACHE" check --out-dir="$out/apa" --cinit=Two \
  --init=IndInit --inv=Exclusion --length=0 ApaInd.tla
expect pass induction-2 induct Two
expect pass induction-3 induct Three
if [ "${FULL:-}" = 1 ]; then expect pass induction-4 induct Four; fi
expect fail non-vacuous induct Two NobodyPotent
expect fail induction-ShortWait induct ShortWait
expect fail induction-NoRoundMatch induct NoRoundMatch
expect fail induction-NoContactReset induct NoContactReset
expect fail induction-NoSessionAge induct NoSessionAge

if [ $failures -gt 0 ]; then
  echo "$failures check(s) did not have the expected outcome"
  exit 1
fi
