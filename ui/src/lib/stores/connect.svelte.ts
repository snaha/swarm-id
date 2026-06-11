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
  /** Agent (automated service) sign-up requested by the dApp. */
  agent: boolean
  /**
   * Set when the proxy iframe could not share localStorage with this popup
   * (storage partitioning). The app secret then goes back to the iframe via
   * a `setSecret` postMessage instead of a storage event.
   */
  partitionChallenge?: string
}

function deriveAppName(origin: string): string {
  try {
    return new URL(origin).hostname.split('.')[0] || origin
  } catch {
    return origin
  }
}

let request = $state<ConnectRequest | undefined>(undefined)

export const connectStore = {
  get request() {
    return request
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
    // to localStorage right before opening the popup. If we can't read it,
    // our storage is partitioned from the iframe's.
    let partitionChallenge: string | undefined = undefined
    const challenge = params.get('challenge')
    if (challenge) {
      if (localStorage.getItem(STORAGE_CHALLENGE_KEY) === challenge) {
        localStorage.removeItem(STORAGE_CHALLENGE_KEY)
      } else {
        partitionChallenge = challenge
      }
    }

    request = {
      appOrigin,
      appName: params.get('appName') ?? deriveAppName(appOrigin),
      appDescription: params.get('appDescription') ?? undefined,
      appIcon: params.get('appIcon') ?? undefined,
      agent: params.has('agent'),
      partitionChallenge,
    }
    return true
  },

  clear() {
    request = undefined
  },
}
