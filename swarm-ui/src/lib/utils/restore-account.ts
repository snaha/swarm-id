// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Account, Identity, ConnectedApp, PostageStamp, Device } from '@snaha/swarm-id'
import { mergeDevices, getOrCreateDeviceId } from '@snaha/swarm-id'
import { createSyncedAccount } from '$lib/domain/synced-account'

interface RestoreData {
  account: Account
  identities: Identity[]
  connectedApps: ConnectedApp[]
  postageStamps: PostageStamp[]
  devices?: Device[]
}

export function restoreAccountToStores(data: RestoreData): Account {
  const devices = mergeDevices(data.devices ?? [], getOrCreateDeviceId())
  const account = createSyncedAccount({ ...data.account, devices })

  for (const identity of data.identities) {
    account.addIdentity(identity)
  }

  for (const app of data.connectedApps) {
    // Reset connectedUntil — the session has logically expired by the time
    // a backup is restored, so apps appear as "previously connected" but
    // require the user to reconnect (which re-establishes the session timer).
    account.connectApp({ ...app, connectedUntil: undefined }, undefined)
  }

  for (const stamp of data.postageStamps) {
    try {
      account.addStamp(stamp)
    } catch (err) {
      console.warn('Skipping duplicate stamp:', err)
    }
  }

  return data.account
}
