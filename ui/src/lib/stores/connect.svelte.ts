// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { STORAGE_CHALLENGE_KEY } from '@snaha/swarm-id'

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
}

/**
 * Remembers (per popup tab) a challenge we already matched in localStorage.
 * The challenge key is consumed on first match, so without this marker a
 * reload or back-navigation re-running initFromHash would misread the missing
 * key as partitioned storage and hand the session over on a channel the dApp
 * is not listening on.
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

    // Storage partitioning detection: the proxy iframe wrote this challenge
    // to localStorage right before opening the popup. If we can't read it
    // (and didn't already consume it earlier in this tab), our storage is
    // partitioned from the iframe's.
    let partitionChallenge: string | undefined = undefined
    const challenge = params.get('challenge')
    if (challenge) {
      if (localStorage.getItem(STORAGE_CHALLENGE_KEY) === challenge) {
        localStorage.removeItem(STORAGE_CHALLENGE_KEY)
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
    }
    return true
  },

  clear() {
    request = undefined
    firstConnect = false
  },
}
