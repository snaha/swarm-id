// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DEFAULT_BEE_NODE_URL,
  DEFAULT_GNOSIS_RPC_URL,
  type NetworkSettings,
  createNetworkSettingsStorageManager,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

export interface NetworkSettingsStore {
  settings: NetworkSettings
  beeNodeUrl: string
  gnosisRpcUrl: string
  updateSettings(newSettings: NetworkSettings): void
  reset(): void
}

function withNetworkSettingsStore(): NetworkSettingsStore {
  const storageManager = browser ? createNetworkSettingsStorageManager() : undefined

  const defaultSettings: NetworkSettings = {
    beeNodeUrl: DEFAULT_BEE_NODE_URL,
    gnosisRpcUrl: DEFAULT_GNOSIS_RPC_URL,
  }

  // Load initial settings from localStorage or use defaults
  const initialSettings = storageManager?.load() ?? defaultSettings

  let settings = $state<NetworkSettings>(initialSettings)

  function updateSettings(newSettings: NetworkSettings) {
    settings = newSettings
    storageManager?.save(newSettings)
  }

  function reset() {
    settings = defaultSettings
    storageManager?.clear()
  }

  return {
    get settings() {
      return settings
    },
    get beeNodeUrl() {
      return settings.beeNodeUrl
    },
    // Settable so the /dev page can bind its URL input straight to the shared
    // setting; persists like updateSettings.
    set beeNodeUrl(url: string) {
      updateSettings({ ...settings, beeNodeUrl: url })
    },
    get gnosisRpcUrl() {
      return settings.gnosisRpcUrl
    },
    updateSettings,
    reset,
  }
}

export const networkSettingsStore = withNetworkSettingsStore()
