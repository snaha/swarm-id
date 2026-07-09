// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pins the signed-out invariants of the live `Account` class: `accessMethod`
 * only exists while the vault does, and neither a getter read nor a late
 * `setAccess` (e.g. a change-method ceremony finishing after a cross-tab
 * sign-out) may act on — or resurrect — a wiped vault.
 */
import { EthAddress } from '@ethersphere/bee-js'
import type { SignedInAccount, SignedOutAccount } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import { Account } from './accounts.svelte'

const noCommit = () => {}

function signedInRecord(): SignedInAccount {
  return {
    id: new EthAddress('a'.repeat(40)),
    name: 'Test Account',
    createdAt: 1700000000000,
    derivationKey: 'f'.repeat(64),
    publicKey: '02' + 'ab'.repeat(32),
    devices: [],
    connectedApps: [],
    postageStamps: [],
    access: { type: 'password', kdfSalt: '00', kdfIterations: 100000 },
    encryptedSeed: 'aabbccdd',
  }
}

function signedOutRecord(): SignedOutAccount {
  const { access: _access, encryptedSeed: _encryptedSeed, ...synced } = signedInRecord()
  return { ...synced, signedOutAt: 1700000000001 }
}

describe('Account.accessMethod', () => {
  it('returns the vault access method while signed in', () => {
    const account = new Account(signedInRecord(), noCommit)
    expect(account.accessMethod.type).toBe('password')
  })

  it('throws for an account loaded as signed out', () => {
    const account = new Account(signedOutRecord(), noCommit)
    expect(account.isSignedOut).toBe(true)
    expect(() => account.accessMethod).toThrow(/signed out/)
  })

  it('throws once signOut() wipes the vault', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.signOut()
    expect(() => account.accessMethod).toThrow(/signed out/)
  })
})

describe('Account.setAccess', () => {
  it('swaps the vault while signed in', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.setAccess({ type: 'passkey', credentialId: 'cred' }, 'bbccddee')
    expect(account.accessMethod.type).toBe('passkey')
  })

  it('throws on a signed-out account instead of re-arming the vault', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.signOut()
    expect(() =>
      account.setAccess({ type: 'password', kdfSalt: '11', kdfIterations: 100000 }, 'bbccddee'),
    ).toThrow(/signed out/)
    // The sign-out survived: still no vault, and the record projects signed out.
    expect(account.isSignedOut).toBe(true)
    expect(account.toRecord()).toMatchObject({ signedOutAt: expect.any(Number) })
  })
})
