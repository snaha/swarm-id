/**
 * Dev Settings Store
 *
 * Store for developer settings used in the /dev page.
 * Controls mock behavior for testing various flows.
 */

export type MockStampResult = 'success' | 'error'

interface DevSettings {
  mockStampEnabled: boolean
  mockStampResult: MockStampResult
}

const settings = $state<DevSettings>({
  mockStampEnabled: import.meta.env.DEV, // Default to DEV mode
  mockStampResult: 'success',
})

export const devSettingsStore = {
  get data() {
    return settings
  },
  setMockStampEnabled(enabled: boolean) {
    settings.mockStampEnabled = enabled
  },
  setMockStampResult(result: MockStampResult) {
    settings.mockStampResult = result
  },
}
