// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { EthAddress } from '@ethersphere/bee-js'
import { describe, expect, it } from 'vitest'

import type { AccountRecord } from '../types'
import { bareHex } from '../utils'
import { backupFilename, createBackup, restoreBackup } from './backup'
import { walletFromPhrase } from './mnemonic'

const PHRASE = 'test test test test test test test test test test test junk'
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const MS_PER_DAY = 24 * 60 * 60 * 1000

function accountFor(phrase: string): AccountRecord {
  const wallet = walletFromPhrase(phrase)
  return {
    id: new EthAddress(bareHex(wallet.address)),
    name: 'Jovial Einstein',
    publicKey: bareHex(wallet.publicKey),
    createdAt: 1765000000000,
    derivationKey: 'f'.repeat(64),
    access: { type: 'password', kdfSalt: '00', kdfIterations: 1 },
    encryptedSeed: '00',
    settings: { appSessionDuration: 30 * MS_PER_DAY },
    devices: [],
    connectedApps: [
      {
        appUrl: 'https://coucou.mail',
        appName: 'Coucou',
        lastConnectedAt: 1765000000000,
        // Live session secret — must NOT survive a backup round-trip.
        appSecret: 'deadbeefdeadbeef',
      },
    ],
    postageStamps: [],
  }
}

describe('backup round-trip', () => {
  it('restores the portable account data with the right phrase', async () => {
    const account = accountFor(PHRASE)
    const wallet = walletFromPhrase(PHRASE)
    const file = await createBackup(account, wallet.entropy)

    const restored = await restoreBackup(file, PHRASE)
    expect(restored.id.toHex()).toBe(account.id.toHex())
    expect(restored.name).toBe('Jovial Einstein')
    expect(restored.connectedApps).toHaveLength(1)
    // The per-app session secret is stripped — restore re-derives it on reconnect.
    expect(restored.connectedApps[0].appSecret).toBeUndefined()
    expect(restored.settings?.appSessionDuration).toBe(30 * MS_PER_DAY)
    // The secret material never leaves the device.
    expect(file).not.toContain('encryptedSeed')
    expect(file).not.toContain('kdfSalt')
  })

  it('rejects the wrong phrase', async () => {
    const account = accountFor(PHRASE)
    const wallet = walletFromPhrase(PHRASE)
    const file = await createBackup(account, wallet.entropy)

    await expect(restoreBackup(file, OTHER_PHRASE)).rejects.toThrow(/does not match/)
  })

  it('rejects garbage files', async () => {
    await expect(restoreBackup('not json', PHRASE)).rejects.toThrow(/Not a valid backup/)
    await expect(restoreBackup('{"hello":1}', PHRASE)).rejects.toThrow(/Not a valid backup/)
  })
})

describe('backupFilename', () => {
  it('formats as YYYYMMDD.swarmid', () => {
    expect(backupFilename(new Date(2026, 5, 8))).toBe('20260608.swarmid')
  })
})
