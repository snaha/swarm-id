// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Dev Settings Store
 *
 * Developer settings used by the /dev page to mock the stamp-purchase widget so
 * the product Add-drive flow can be exercised without a real cross-chain payment,
 * and to switch the experimental card payment on. That one is read in a build
 * too, where /dev is not shipped: set the `dev-card-payment-enabled` key to
 * `true` in local storage by hand (snaha/swarm-id#858).
 */
import { browser } from '$app/environment'

export type MockStampResult = 'success' | 'error'

interface DevSettings {
  mockStampEnabled: boolean
  // When mocking, also open the widget's `?mocked=true` popup (to eyeball the
  // popup path in a real browser). Off → pure local simulation, no `window.open`.
  mockStampPopup: boolean
  mockStampResult: MockStampResult
  // Offer "Pay with card" in the add-drive chooser. Off by default everywhere
  // until the route leaves the experiment (#858).
  cardPaymentEnabled: boolean
}

// Persist mock mode in localStorage so an explicit choice is durable and shared
// across same-origin tabs (the buy flow often runs in a different tab/window than
// /dev). It defaults to `import.meta.env.DEV` only when never set; once toggled,
// the choice sticks until changed again.
const MOCK_ENABLED_KEY = 'dev-mock-stamp-enabled'
const MOCK_POPUP_KEY = 'dev-mock-stamp-popup'
const MOCK_RESULT_KEY = 'dev-mock-stamp-result'
const CARD_PAYMENT_KEY = 'dev-card-payment-enabled'

function loadMockEnabled(): boolean {
  if (!browser) return import.meta.env.DEV
  const stored = localStorage.getItem(MOCK_ENABLED_KEY)
  return stored === undefined || stored === null ? import.meta.env.DEV : stored === 'true'
}

function loadMockPopup(): boolean {
  return browser && localStorage.getItem(MOCK_POPUP_KEY) === 'true'
}

function loadMockResult(): MockStampResult {
  return browser && localStorage.getItem(MOCK_RESULT_KEY) === 'error' ? 'error' : 'success'
}

function loadCardPaymentEnabled(): boolean {
  return browser && localStorage.getItem(CARD_PAYMENT_KEY) === 'true'
}

const settings = $state<DevSettings>({
  mockStampEnabled: loadMockEnabled(),
  mockStampPopup: loadMockPopup(),
  mockStampResult: loadMockResult(),
  cardPaymentEnabled: loadCardPaymentEnabled(),
})

if (browser) {
  // Cross-tab sync: a disable/enable on /dev in another tab must reach a tab that
  // already has the buy flow open, otherwise that tab's in-memory copy stays stale
  // and keeps mocking.
  window.addEventListener('storage', (e) => {
    if (e.key === MOCK_ENABLED_KEY) settings.mockStampEnabled = loadMockEnabled()
    if (e.key === MOCK_POPUP_KEY) settings.mockStampPopup = loadMockPopup()
    if (e.key === MOCK_RESULT_KEY) settings.mockStampResult = loadMockResult()
    if (e.key === CARD_PAYMENT_KEY) settings.cardPaymentEnabled = loadCardPaymentEnabled()
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
  setMockStampPopup(popup: boolean) {
    settings.mockStampPopup = popup
    if (browser) localStorage.setItem(MOCK_POPUP_KEY, String(popup))
  },
  setMockStampResult(result: MockStampResult) {
    settings.mockStampResult = result
    if (browser) localStorage.setItem(MOCK_RESULT_KEY, result)
  },
  setCardPaymentEnabled(enabled: boolean) {
    settings.cardPaymentEnabled = enabled
    if (browser) localStorage.setItem(CARD_PAYMENT_KEY, String(enabled))
  },
}
