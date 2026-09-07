# `@swarm-id/signaling` — account-bus signaling and relay server

The one server the account bus needs ([`docs/Account-Bus.md`](../docs/Account-Bus.md)). Peers
of one account meet here, upgrade to direct WebRTC DataChannels where they can, and fall back to
relaying through this socket where they cannot. It does two things and nothing else:

- **`signal`** — forward a WebRTC offer/answer/ICE blob to one named peer in the same room.
- **`relay`** — forward an opaque, end-to-end encrypted payload to one named peer.

Both go to exactly one peer; there is deliberately no room-wide broadcast. The server never
sees plaintext, stores nothing, and keeps no state beyond the map of rooms to open sockets.

## Wire

Every frame is a JSON object with a `type`:

| Direction       | Frame                                                               | Meaning                                                                              |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| client → server | `{ type: "join", topic }`                                           | Name the room. First frame on the socket; the topic never travels in the URL (#577). |
| server → client | `{ type: "welcome", peerId, peers }`                                | Your id and the ids already in the room. The newcomer initiates WebRTC toward each.  |
| server → room   | `{ type: "peer-joined", peerId }` / `{ type: "peer-left", peerId }` | Membership changes.                                                                  |
| client → server | `{ type: "signal", to, payload }`                                   | Forwarded as `{ type: "signal", from, payload }`.                                    |
| client → server | `{ type: "relay", to, payload }`                                    | Forwarded as `{ type: "relay", from, payload }`. `payload` is ciphertext.            |

Topics are 16–128 lower-case hex characters, derived per account by the clients
(`deriveBusContext` in the lib); the server treats them as opaque room names.

## Limits and close codes

Global rather than per-IP, because the service sits behind the platform ingress and the
client address only exists in a spoofable header: 500 connections, 200 rooms, 24 peers per
room, a per-socket message budget sized from the WebRTC negotiation cost per peer, a 64 KiB
payload cap, and a join timeout for a socket that never names a room. A server-side ping every
30 s terminates a socket that has not answered by the next tick, which is what turns a
half-open peer into `peer-left`.

`1008` (policy violation) is permanent for that topic and the client stops reconnecting: the
server only sends it for a topic it would refuse identically next time. A socket that never sent
its join frame gets `4408` instead, precisely so it is not read that way.
`1013` (try again later) is transient and the client backs off with jitter; `4408` is the join
timeout. The exact values and the reasoning behind each live in the header of
[`src/server.ts`](./src/server.ts), which is the source of truth.

## Running it

```bash
PORT=5520 pnpm --filter @swarm-id/signaling start   # what `pnpm dev` runs alongside the UI and demo
pnpm --filter @swarm-id/signaling test
```

The UI reaches it through `PUBLIC_BUS_SIGNALING_URL` (baked in at build time); in dev it falls
back to `ws://localhost:5520`. In production it is the `bus-signaling` service of
`.do/swarm-id-app.yaml`, reached at `wss://swarm-id.snaha.net/bus` with `/healthz` for the
platform's health check. A build with no URL configured (GitHub Pages) runs the bus over
`BroadcastChannel` only.
