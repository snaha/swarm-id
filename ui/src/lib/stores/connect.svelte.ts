// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type Permissions, PermissionsSchema, storageChallengeKey } from '@snaha/swarm-id/internal'

import type { Account } from '$lib/types'

/**
 * A dApp connection request, parsed from the URL hash the @snaha/swarm-id
 * client puts on the connect popup (e.g. #origin=…&appName=…&challenge=…).
 * Held in memory so it survives in-popup navigation through the account
 * creation flow; lost on reload by design (the user can retry from the dApp).
 */
export interface ConnectRequest {
  appOrigin: string
  appName: string
  appDescription?: string
  appIcon?: string
  /**
   * Set when the proxy iframe could not share localStorage with this popup
   * (storage partitioning). The app secret then goes back to the iframe via
   * a `setSecret` postMessage instead of a storage event.
   */
  partitionChallenge?: string
  /**
   * The challenge as the URL carried it, whether or not it matched: present
   * exactly when the proxy iframe opened this popup, so a message to
   * `window.opener` reaches the iframe rather than the app page (#849).
   */
  challenge?: string
  /**
   * What the app asked for (#862): `drives` is `"all"`, or a row per drive
   * for the done page's picker. Absent when the app asked for nothing, which
   * keeps the account default.
   */
  permissions?: Permissions
}

/**
 * An approved connection the done page has yet to commit: the handshake
 * runs on "Go to app", after the drive picker, so a partitioned session is
 * handed exactly the drives the grant names. `appSecret` is this one app's
 * secret, derived at unlock or reused from a still-valid prior connection;
 * the master key material never reaches this store.
 */
export interface PendingConnect {
  account: Account
  appSecret: string
}

/**
 * Remembers (per popup tab) a challenge we already matched in localStorage.
 * The proxy drops the challenge's key once the attempt ends, so without this
 * marker a reload or back-navigation re-running initFromHash would misread
 * the missing key as partitioned storage and hand the session over on a
 * channel the dApp is not listening on.
 */
const CHALLENGE_MATCHED_KEY = 'swarm-id-challenge-matched'

function deriveAppName(origin: string): string {
  try {
    return new URL(origin).hostname.split('.')[0] || origin
  } catch {
    return origin
  }
}

let request = $state<ConnectRequest | undefined>(undefined)
// Whether the connect that just completed was the account's FIRST to this app
// (no active connected-app entry at select time). Set by the chooser right
// before the handshake; the done page keys the drive-picker variant off it.
let firstConnect = $state(false)
let pending = $state<PendingConnect | undefined>(undefined)

function parsePermissions(raw: string | null): Permissions | undefined {
  if (raw === null) return undefined
  try {
    const parsed = PermissionsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const connectStore = {
  get request() {
    return request
  },

  get firstConnect() {
    return firstConnect
  },

  setFirstConnect(value: boolean) {
    firstConnect = value
  },
  get pending() {
    return pending
  },
  setPending(value: PendingConnect) {
    pending = value
  },

  /**
   * Parse a connect request from the popup URL hash. Keeps any previously
   * parsed request when the hash carries none (e.g. back-navigation to
   * /connect). Returns whether a request is active afterwards.
   */
  initFromHash(hash: string): boolean {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral, parsed and discarded
    const params = new URLSearchParams(hash.slice(1))
    const appOrigin = params.get('origin')
    if (!appOrigin) {
      return request !== undefined
    }

    // Storage partitioning detection: the proxy iframe armed this challenge
    // in its localStorage before the popup was opened. If we can't read it
    // (and didn't already match it earlier in this tab), our storage is
    // partitioned from the iframe's. The key stays: the proxy owns it, and a
    // second popup of the same attempt reads it too.
    let partitionChallenge: string | undefined = undefined
    const challenge = params.get('challenge')
    if (challenge) {
      if (localStorage.getItem(storageChallengeKey(challenge)) !== null) {
        sessionStorage.setItem(CHALLENGE_MATCHED_KEY, challenge)
      } else if (sessionStorage.getItem(CHALLENGE_MATCHED_KEY) !== challenge) {
        partitionChallenge = challenge
      }
    }

    request = {
      appOrigin,
      appName: params.get('appName') ?? deriveAppName(appOrigin),
      appDescription: params.get('appDescription') ?? undefined,
      appIcon: params.get('appIcon') ?? undefined,
      partitionChallenge,
      challenge: challenge ?? undefined,
      permissions: parsePermissions(params.get('permissions')),
    }
    return true
  },

  clear() {
    request = undefined
    firstConnect = false
    pending = undefined
  },
}
