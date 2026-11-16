// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The signaling wire protocol, shared by both ends (#700): the server parses
 * `ClientMessageSchema` and composes `ServerMessage`, the client transport in
 * `lib/src/bus/signaling-transport.ts` does the reverse. Zod only — no `ws`,
 * no `node:*` — so the browser bundle can inline it.
 */

import { z } from 'zod'

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('join'), topic: z.string() }),
  z.object({ type: z.literal('relay'), to: z.string(), payload: z.string() }),
  z.object({ type: z.literal('signal'), to: z.string(), payload: z.unknown() }),
  /**
   * Answered with a `pong` carrying the same nonce, and only to a socket that
   * is in a room. The round trip is how a client knows its own connection
   * works: the server's protocol-level pings are invisible to browser code.
   * A client sends one for each `tick`.
   */
  z.object({ type: z.literal('ping'), nonce: z.number().int().nonnegative() }),
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), peerId: z.string(), peers: z.array(z.string()) }),
  z.object({ type: z.literal('peer-joined'), peerId: z.string() }),
  z.object({ type: z.literal('peer-left'), peerId: z.string() }),
  z.object({ type: z.literal('relay'), from: z.string(), payload: z.string() }),
  z.object({ type: z.literal('signal'), from: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal('pong'), nonce: z.number() }),
  /**
   * "Ping me now", sent to every room member at the server's cadence. The
   * clock is the server's because a hidden page's own timers are throttled to
   * about one a minute, while a message event still runs at once.
   */
  z.object({ type: z.literal('tick') }),
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

/**
 * The client treats this as permanent and stops reconnecting for good, so it is
 * reserved for the one thing that will never come right: a topic this server
 * refuses and would refuse identically on every retry. Everything else — load,
 * an exhausted budget — closes with 1013.
 */
export const WS_CLOSE_POLICY_VIOLATION = 1008
/** Transient — the client backs off and comes back. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013
/**
 * A socket that never named a room (`preJoinTimeoutMs`). Its own code rather
 * than 1008, because 1008 already means "this server predates the join frame"
 * to a client, which answers it by putting the topic back in the URL for the
 * life of the page — the exact thing #577 removes. Application range (4000+),
 * numbered after HTTP 408 so it reads as what it is; a client that does not
 * know it backs off and retries, which is the right answer for a socket that
 * failed to speak in time.
 */
export const WS_CLOSE_JOIN_TIMEOUT = 4408
