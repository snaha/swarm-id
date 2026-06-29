// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Dev Settings Store
 *
 * Store for developer settings used in the /dev page.
 * Controls mock behavior for testing various flows.
 */
import { browser } from '$app/environment'

export type MockStampResult = 'success' | 'error'

interface DevSettings {
  mockStampEnabled: boolean
  mockStampResult: MockStampResult
}

// Persist mock mode in localStorage so an explicit choice is durable and shared
// across same-origin tabs (the buy flow often runs in a different tab/window than
// /dev). It defaults to `import.meta.env.DEV` only when never set; once toggled,
// the choice sticks until changed again.
const MOCK_ENABLED_KEY = 'dev-mock-stamp-enabled'
const MOCK_RESULT_KEY = 'dev-mock-stamp-result'

function loadMockEnabled(): boolean {
  if (!browser) return import.meta.env.DEV
  const stored = localStorage.getItem(MOCK_ENABLED_KEY)
  return stored === null ? import.meta.env.DEV : stored === 'true'
}

function loadMockResult(): MockStampResult {
  return browser && localStorage.getItem(MOCK_RESULT_KEY) === 'error' ? 'error' : 'success'
}

const settings = $state<DevSettings>({
  mockStampEnabled: loadMockEnabled(),
  mockStampResult: loadMockResult(),
})

if (browser) {
  // Cross-tab sync: a disable/enable on /dev in another tab must reach a tab that
  // already has the buy flow open, otherwise that tab's in-memory copy stays stale
  // and keeps mocking.
  window.addEventListener('storage', (e) => {
    if (e.key === MOCK_ENABLED_KEY) settings.mockStampEnabled = loadMockEnabled()
    if (e.key === MOCK_RESULT_KEY) settings.mockStampResult = loadMockResult()
  })
}

export const devSettingsStore = {
  get data() {
    return settings
  },
  setMockStampEnabled(enabled: boolean) {
    settings.mockStampEnabled = enabled
    if (browser) localStorage.setItem(MOCK_ENABLED_KEY, String(enabled))
  },
  setMockStampResult(result: MockStampResult) {
    settings.mockStampResult = result
    if (browser) localStorage.setItem(MOCK_RESULT_KEY, result)
  },
}
