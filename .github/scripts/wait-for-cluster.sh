#!/usr/bin/env bash
# Wait until the local Bee cluster (`pnpm dev:cluster:start`) serves a direct
# upload promptly — the write every suite in CI makes.
#
# The queen's /readiness only says its API is up. On a cold cluster the
# workers are still settling behind it, and until they have, a direct upload
# (`swarm-deferred-upload: false`, what the proxy's chunk and lock writes are)
# is answered 201 only after ~30 s: the suites then time out on writes that
# say nothing about what they test. So this waits for the thing itself. Every
# started node has to be ready and the queen connected to each worker — with
# no peers the queen stores a chunk itself and answers fast, which proves
# nothing — then a stamp is bought on the queen (or reused: the same amount
# and depth as the integration suite's, which picks it up instead of buying
# its own) and direct /chunks POSTs are made until three in a row come back
# within a second. The ceiling is CLUSTER_WAIT_MINUTES (default 15) for the
# whole wait; a slow probe prints the queen's topology so the log says what
# the cluster was still waiting for.
set -euo pipefail

QUEEN=${QUEEN_API:-http://localhost:1633}
DEADLINE=$(( $(date +%s) + ${CLUSTER_WAIT_MINUTES:-15} * 60 ))
POLL_SECONDS=3
CRASH_LOOP_RESTARTS=3
# Mirrors TEST_STAMP_AMOUNT / TEST_STAMP_DEPTH in lib/test/integration/cluster.ts.
STAMP_AMOUNT=500000000
STAMP_DEPTH=20
FAST_SECONDS=1
FAST_IN_A_ROW=3

log() { echo "$(date +%H:%M:%S) $*" >&2; }
fail() { echo "::error::$*" >&2; exit 1; }
expired() { [ "$(date +%s)" -ge "$DEADLINE" ]; }
# A read of the queen's API; empty rather than fatal when it does not answer.
get() { curl -fsS "$QUEEN$1" 2>/dev/null || true; }

wait_ready() { # <container> <api>
  local restarts
  while ! curl -fsS "$2/readiness" 2>/dev/null | grep -q '"status":"ready"'; do
    restarts=$(docker inspect -f '{{.RestartCount}}' "bee-compose-$1" 2>/dev/null || echo 0)
    if [ "${restarts:-0}" -ge "$CRASH_LOOP_RESTARTS" ]; then
      fail "$1 is crash-looping (RestartCount=$restarts)"
    fi
    expired && fail "$1 did not become ready in time"
    sleep "$POLL_SECONDS"
  done
  log "$1 is ready"
}

topology() {
  get /topology | jq -c '{connected, depth, reachability,
    peers: [.bins[] | .connectedPeers[]? | {address: .address[0:8], healthy: .metrics.healthy, reachability: .metrics.reachability}]}'
}

wait_connected() { # <worker count>
  local connected
  while :; do
    connected=$(get /topology | jq -r '.connected // 0')
    [ "${connected:-0}" -ge "$1" ] && break
    expired && fail "the queen sees ${connected:-0} of $1 workers: $(topology)"
    sleep "$POLL_SECONDS"
  done
  log "the queen is connected to $connected peers"
}

usable_stamp() {
  local id response code body
  id=$(get /stamps | jq -r --argjson depth "$STAMP_DEPTH" \
    '[.stamps[]? | select(.usable and .depth == $depth)][0].batchID // empty')
  if [ -n "$id" ]; then
    log "reusing stamp $id"
    echo "$id"
    return
  fi
  # 429 while the node has another transaction in flight: ask again.
  while :; do
    response=$(curl -sS -w '\n%{http_code}' -X POST "$QUEEN/stamps/$STAMP_AMOUNT/$STAMP_DEPTH" 2>/dev/null || echo $'\n000')
    code=${response##*$'\n'}
    body=${response%$'\n'*}
    [ "$code" = 201 ] && break
    log "buying a stamp: HTTP $code $body"
    expired && fail "could not buy a stamp on the queen"
    sleep "$POLL_SECONDS"
  done
  id=$(jq -r .batchID <<<"$body")
  log "bought stamp $id, waiting for it to be usable"
  while ! get "/stamps/$id" | jq -e .usable >/dev/null 2>&1; do
    expired && fail "stamp $id never became usable"
    sleep "$POLL_SECONDS"
  done
  echo "$id"
}

# One direct upload of a fresh random chunk; prints "<http code> <seconds>".
probe() { # <batch id>
  local chunk=/tmp/wait-for-cluster-chunk
  # An 8-byte little-endian span of 64, then 64 random bytes: a chunk the
  # cluster has never seen, so every probe is pushed rather than found.
  { printf '\x40\x00\x00\x00\x00\x00\x00\x00'; head -c 64 /dev/urandom; } > "$chunk"
  curl -sS -o /dev/null -w '%{http_code} %{time_total}' -X POST "$QUEEN/chunks" \
    -H "swarm-postage-batch-id: $1" -H 'swarm-deferred-upload: false' \
    -H 'content-type: application/octet-stream' --data-binary "@$chunk" 2>/dev/null || echo '000 0'
}

fast() { # <http code> <seconds>
  [ "$1" = 201 ] && awk -v seconds="$2" -v limit="$FAST_SECONDS" 'BEGIN { exit !(seconds < limit) }'
}

wait_ready queen "$QUEEN"
workers=0
# worker-N answers on port 1633N (compose.yml); the started ones are the containers.
for name in $(docker ps --filter 'name=bee-compose-worker-' --format '{{.Names}}'); do
  workers=$((workers + 1))
  wait_ready "${name#bee-compose-}" "http://localhost:1633${name##*-}"
done
# With no worker container the connected check passes at 0 and the probe then
# measures a queen storing its own chunk — fast, and proof of nothing.
[ "$workers" -gt 0 ] || fail "no bee-compose worker container is running"
wait_connected "$workers"

batch=$(usable_stamp)
in_a_row=0
while :; do
  read -r code seconds <<<"$(probe "$batch")"
  if fast "$code" "$seconds"; then
    in_a_row=$((in_a_row + 1))
    if [ "$in_a_row" -ge "$FAST_IN_A_ROW" ]; then
      log "direct upload served in ${seconds}s, $FAST_IN_A_ROW in a row: the cluster is warm"
      exit 0
    fi
    continue
  fi
  in_a_row=0
  log "direct upload: HTTP $code in ${seconds}s, topology $(topology)"
  expired && fail "the cluster still does not serve a direct upload promptly (last: HTTP $code in ${seconds}s)"
  sleep "$POLL_SECONDS"
done
