// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { EthAddress } from '@ethersphere/bee-js'
import type { Account as AccountRecord } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import { daysToMs } from '../duration'
import { backupFilename, createBackup, restoreBackup } from './backup'
import { strip0x } from './hex'
import { walletFromPhrase } from './mnemonic'

const PHRASE = 'test test test test test test test test test test test junk'
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

function accountFor(phrase: string): AccountRecord {
  const wallet = walletFromPhrase(phrase)
  return {
    id: new EthAddress(wallet.address),
    name: 'Jovial Einstein',
    publicKey: strip0x(wallet.publicKey),
    createdAt: 1765000000000,
    derivationKey: 'f'.repeat(64),
    access: { type: 'password', kdfSalt: '00', kdfIterations: 1 },
    encryptedSeed: '00',
    settings: { appSessionDuration: daysToMs(30) },
    // Per-field LWW clocks — must survive the round-trip so merge doesn't fall back.
    accountNameAt: 1765000001000,
    settingsAt: 1765000002000,
    defaultStampAt: 1765000002500,
    lastModified: 1765000003000,
    devices: [],
    connectedApps: [
      {
        appUrl: 'https://coucou.mail',
        appName: 'Coucou',
        lastConnectedAt: 1765000000000,
        // Live session material — must NOT survive a backup round-trip: the
        // secret is what the proxy authenticates from, and `connectedUntil`
        // without it would render a "Connected" app that can't authenticate.
        appSecret: 'deadbeefdeadbeef',
        connectedUntil: 4102444800000,
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
    // The live session material is stripped — restore re-derives the secret on
    // reconnect, and a leftover `connectedUntil` would show a false "Connected".
    expect(restored.connectedApps[0].appSecret).toBeUndefined()
    expect(restored.connectedApps[0].connectedUntil).toBeUndefined()
    expect(restored.settings?.appSessionDuration).toBe(daysToMs(30))
    // Convergence clocks survive so merge doesn't treat restored scalars as stale.
    expect(restored.accountNameAt).toBe(1765000001000)
    expect(restored.settingsAt).toBe(1765000002000)
    expect(restored.defaultStampAt).toBe(1765000002500)
    expect(restored.lastModified).toBe(1765000003000)
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
