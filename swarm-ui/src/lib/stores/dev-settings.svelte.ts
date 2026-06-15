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

// Persist mock mode in sessionStorage so toggling it off survives navigation
// (e.g. creating a user and returning to /dev) within the same tab session.
const MOCK_ENABLED_KEY = 'dev-mock-stamp-enabled'
const MOCK_RESULT_KEY = 'dev-mock-stamp-result'

function loadMockEnabled(): boolean {
  if (!browser) return import.meta.env.DEV
  const stored = sessionStorage.getItem(MOCK_ENABLED_KEY)
  return stored === undefined || stored === null ? import.meta.env.DEV : stored === 'true'
}

function loadMockResult(): MockStampResult {
  return browser && sessionStorage.getItem(MOCK_RESULT_KEY) === 'error' ? 'error' : 'success'
}

const settings = $state<DevSettings>({
  mockStampEnabled: loadMockEnabled(),
  mockStampResult: loadMockResult(),
})

export const devSettingsStore = {
  get data() {
    return settings
  },
  setMockStampEnabled(enabled: boolean) {
    settings.mockStampEnabled = enabled
    if (browser) sessionStorage.setItem(MOCK_ENABLED_KEY, String(enabled))
  },
  setMockStampResult(result: MockStampResult) {
    settings.mockStampResult = result
    if (browser) sessionStorage.setItem(MOCK_RESULT_KEY, result)
  },
}
