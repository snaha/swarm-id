// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Dev Settings Store
 *
 * Whether a purchase is simulated is NOT a setting: it follows the chain. On a
 * dev chain the real payment legs (the widget's cross-chain payment, Relay)
 * cannot complete at all, so simulating is the only thing that works; on
 * mainnet simulating would be a lie. `chainIdentity()` decides.
 *
 * What remains is the one thing the chain cannot tell us: whether we want the
 * simulated purchase to succeed or to fail, for exercising the error path.
 */
import { browser } from '$app/environment'

export type MockStampResult = 'success' | 'error'

interface DevSettings {
  mockStampResult: MockStampResult
}

// Persisted so the choice is durable and shared across same-origin tabs — the
// buy flow often runs in a different tab than /dev.
const MOCK_RESULT_KEY = 'dev-mock-stamp-result'

function loadMockResult(): MockStampResult {
  return browser && localStorage.getItem(MOCK_RESULT_KEY) === 'error' ? 'error' : 'success'
}

const settings = $state<DevSettings>({
  mockStampResult: loadMockResult(),
})

if (browser) {
  // Cross-tab sync: a change on /dev must reach a tab that already has the buy
  // flow open, otherwise that tab keeps the stale choice.
  window.addEventListener('storage', (e) => {
    if (e.key === MOCK_RESULT_KEY) settings.mockStampResult = loadMockResult()
  })
}

export const devSettingsStore = {
  get data() {
    return settings
  },
  setMockStampResult(result: MockStampResult) {
    settings.mockStampResult = result
    if (browser) localStorage.setItem(MOCK_RESULT_KEY, result)
  },
}
