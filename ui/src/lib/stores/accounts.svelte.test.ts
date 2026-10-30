// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Two suites over the accounts store and its live `Account` class:
 *
 * - Store-level: the persist read-merge-write (two-tab race) and tolerance of
 *   a malformed (tampered) current-account id.
 * - Class-level: the sign-out invariants — the vault (and `accessMethod`)
 *   survives a sign-out so the sign-back-in ceremony can unlock it, while
 *   every synced field (incl. the secret `derivationKey`) is stripped from
 *   memory and the projected record; a late `setAccess` (e.g. a change-method
 *   ceremony finishing after a cross-tab sign-out) may not undo the sign-out.
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import {
  type Account as AccountRecord,
  type SignedInAccount,
  type SignedOutAccount,
  createAccountsStorageManager,
} from '@snaha/swarm-id/internal'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Account, accountsStore } from './accounts.svelte'

// The store module reads `browser` and (indirectly, via the lib storage
// manager) `window.localStorage` at import time — install both before it loads.
// `browser: false` keeps the boot-time load and the storage listener off; every
// test builds its state explicitly through `accountsStore.add()`.
vi.mock('$app/environment', () => ({ browser: false }))

vi.hoisted(() => {
  const backing = new Map<string, string>()
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  }
  Object.assign(globalThis, {
    window: {
      localStorage: localStorageStub,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
    localStorage: localStorageStub,
  })
})

const X_ID_HEX = 'a'.repeat(40)
const Y_ID_HEX = 'b'.repeat(40)

function record(idHex: string, name: string): AccountRecord {
  return {
    id: new EthAddress(idHex),
    name,
    createdAt: 1,
    derivationKey: 'f'.repeat(64),
    publicKey: '02' + 'ab'.repeat(32),
    access: { type: 'password', kdfSalt: 'a'.repeat(32), kdfIterations: 1 },
    encryptedSeed: 'ab'.repeat(44),
    devices: [],
    connectedApps: [],
    postageStamps: [],
  }
}

/** Read what is actually persisted, through an independent manager instance. */
function stored(): AccountRecord[] {
  return createAccountsStorageManager().load()
}

/**
 * Simulate another tab writing account `idHex` with a new name: mutate storage
 * through a separate manager instance. The store under test only refreshes on
 * real cross-tab `storage` events (which never fire here), so it stays stale —
 * exactly the interleaving window of the two-tab race.
 */
function otherTabRenames(idHex: string, name: string): void {
  const manager = createAccountsStorageManager()
  manager.save(
    manager
      .load()
      .map((account) =>
        account.id.equals(new EthAddress(idHex)) ? { ...account, name } : account,
      ),
  )
}

beforeEach(() => {
  accountsStore.clear()
})

describe('persist read-merge-write (two-tab race)', () => {
  it('a mutation keeps a concurrent write to ANOTHER account made by another tab', () => {
    accountsStore.add(record(X_ID_HEX, 'x'))
    accountsStore.add(record(Y_ID_HEX, 'y'))

    otherTabRenames(Y_ID_HEX, 'y-from-tab2')
    accountsStore.get(X_ID_HEX)?.rename('x-renamed')

    const names = new Map(stored().map((account) => [account.id.toHex(), account.name]))
    expect(names.get(new EthAddress(X_ID_HEX).toHex())).toBe('x-renamed')
    expect(names.get(new EthAddress(Y_ID_HEX).toHex())).toBe('y-from-tab2')
  })

  it('add() keeps a concurrent write to another account', () => {
    accountsStore.add(record(X_ID_HEX, 'x'))
    otherTabRenames(X_ID_HEX, 'x-from-tab2')

    accountsStore.add(record(Y_ID_HEX, 'y'))

    const names = new Map(stored().map((account) => [account.id.toHex(), account.name]))
    expect(names.get(new EthAddress(X_ID_HEX).toHex())).toBe('x-from-tab2')
    expect(names.get(new EthAddress(Y_ID_HEX).toHex())).toBe('y')
  })

  it('remove() keeps a concurrent write to another account', () => {
    accountsStore.add(record(X_ID_HEX, 'x'))
    accountsStore.add(record(Y_ID_HEX, 'y'))
    otherTabRenames(Y_ID_HEX, 'y-from-tab2')

    accountsStore.remove(X_ID_HEX)

    const records = stored()
    expect(records).toHaveLength(1)
    expect(records[0]?.name).toBe('y-from-tab2')
  })

  it('a mutation round-trips to storage (sanity)', () => {
    accountsStore.add(record(X_ID_HEX, 'x'))
    accountsStore.get(X_ID_HEX)?.rename('x-renamed')

    expect(stored()[0]?.name).toBe('x-renamed')
  })
})

// The proxy inside the proxy iframe subscribes beside this store and publishes
// what it is told about — unless the write says peers must not hear of it.
// A regression in this plumb reintroduces the echo of #707 silently.
describe('persist tells the same-window proxy which writes not to republish', () => {
  function detailOfLastWrite(): { noRepublish?: boolean } {
    const spy = vi.mocked(window.dispatchEvent)
    const event = spy.mock.calls.at(-1)?.[0] as CustomEvent<{ noRepublish?: boolean }>
    return event.detail
  }

  beforeEach(() => {
    vi.spyOn(window, 'dispatchEvent')
  })

  it("a plain mutation is this device's change to publish", () => {
    accountsStore.add(record(X_ID_HEX, 'x')).rename('renamed')
    expect(detailOfLastWrite().noRepublish).toBeFalsy()
  })

  it('a skipSync commit is marked noRepublish', () => {
    accountsStore.add(record(X_ID_HEX, 'x')).signOut(ENCRYPTED_STATE)
    expect(detailOfLastWrite().noRepublish).toBe(true)
  })
})

describe('malformed account id (tampered current-account key)', () => {
  it('get() returns undefined instead of throwing', () => {
    accountsStore.add(record(X_ID_HEX, 'x'))

    expect(accountsStore.get('not-a-valid-address')).toBeUndefined()
  })

  it('remove() is a no-op instead of throwing', () => {
    accountsStore.add(record(X_ID_HEX, 'x'))

    expect(() => accountsStore.remove('not-a-valid-address')).not.toThrow()
    expect(accountsStore.accounts).toHaveLength(1)
  })
})

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

const ENCRYPTED_STATE =
  '{"format":"swarm-id-signout-state","version":1,"salt":"00","payload":"aabb"}'

function signedOutRecord(): SignedOutAccount {
  const { id, name, createdAt, access, encryptedSeed } = signedInRecord()
  return {
    id,
    name,
    createdAt,
    access,
    encryptedSeed,
    encryptedState: ENCRYPTED_STATE,
    signedOutAt: 1700000000001,
  }
}

describe('Account sign-out state', () => {
  it('returns the vault access method while signed in', () => {
    const account = new Account(signedInRecord(), noCommit)
    expect(account.accessMethod.type).toBe('password')
  })

  it('keeps the access method readable for an account loaded as signed out', () => {
    const account = new Account(signedOutRecord(), noCommit)
    expect(account.isSignedOut).toBe(true)
    expect(account.accessMethod.type).toBe('password')
  })

  it('hydrates a signed-out record with empty synced fields', () => {
    const account = new Account(signedOutRecord(), noCommit)
    expect(account.derivationKey).toBe('')
    expect(account.publicKey).toBe('')
    expect(account.connectedApps).toEqual([])
    expect(account.postageStamps).toEqual([])
    expect(account.devices).toEqual([])
  })
})

describe('Account.signOut', () => {
  it('retains the vault and the snapshot, strips the synced fields from memory', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.signOut(ENCRYPTED_STATE)
    expect(account.isSignedOut).toBe(true)
    expect(account.accessMethod.type).toBe('password')
    expect(account.vault.encryptedSeed).toBe('aabbccdd')
    expect(account.encryptedState).toBe(ENCRYPTED_STATE)
    expect(account.derivationKey).toBe('')
    expect(account.connectedApps).toEqual([])
  })

  it('projects exactly the minimal remnant record', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.signOut(ENCRYPTED_STATE)
    expect(Object.keys(account.toRecord()).sort()).toEqual([
      'access',
      'createdAt',
      'encryptedSeed',
      'encryptedState',
      'id',
      'name',
      'signedOutAt',
      'soonestDriveExpiry',
      'storageWarning',
    ])
  })

  it('signs back in when a full record replaces it through accountsStore.add', () => {
    const live = accountsStore.add(record(X_ID_HEX, 'x'))
    live.signOut(ENCRYPTED_STATE)
    expect(live.isSignedOut).toBe(true)

    const restored = accountsStore.add(record(X_ID_HEX, 'x'))

    expect(restored).toBe(live) // instance reused, held references stay valid
    expect(live.isSignedOut).toBe(false)
    expect(live.signedOutAt).toBeUndefined()
    expect(live.encryptedState).toBeUndefined()
    expect(live.derivationKey).toBe('f'.repeat(64))
  })
})

describe('Account.signOut storage-warning remnant', () => {
  const DAY_S = 24 * 60 * 60
  const fullDrive = {
    batchID: new BatchId('c'.repeat(64)),
    signerKey: new PrivateKey('d'.repeat(64)),
    utilization: 1,
    usable: true,
    depth: 20,
    amount: 100000000n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    exists: true,
    batchTTL: 30 * DAY_S,
    createdAt: Date.now(),
  }

  it('captures the warning flag and soonest expiry from the live drives', () => {
    const account = new Account({ ...signedInRecord(), postageStamps: [fullDrive] }, noCommit)
    account.signOut(ENCRYPTED_STATE)
    expect(account.storageWarning).toBe(true)
    expect(account.soonestDriveExpiry).toBeGreaterThan(Date.now())
    expect(account.toRecord()).toMatchObject({
      storageWarning: true,
      soonestDriveExpiry: expect.any(Number),
    })
  })

  it('records no warning for a healthy account', () => {
    const account = new Account(
      { ...signedInRecord(), postageStamps: [{ ...fullDrive, utilization: 0.1 }] },
      noCommit,
    )
    account.signOut(ENCRYPTED_STATE)
    expect(account.storageWarning).toBe(false)
    expect(account.soonestDriveExpiry).toBeGreaterThan(Date.now())
  })

  it('round-trips the remnant through a record', () => {
    const account = new Account({ ...signedInRecord(), postageStamps: [fullDrive] }, noCommit)
    account.signOut(ENCRYPTED_STATE)
    const rehydrated = new Account(account.toRecord(), noCommit)
    expect(rehydrated.storageWarning).toBe(true)
    expect(rehydrated.soonestDriveExpiry).toBe(account.soonestDriveExpiry)
  })
})

describe('Account.setAppPermissions — drives', () => {
  const APP_URL = 'https://app.example.com'
  const BATCH_HEX = 'c'.repeat(64)

  function accountWithApp(): Account {
    return new Account(
      {
        ...signedInRecord(),
        connectedApps: [{ appUrl: APP_URL, appName: 'Test App', lastConnectedAt: 1 }],
      },
      noCommit,
    )
  }

  // On its own clock, not the entry's: the grant says nothing about whether
  // the app is still connected, and ranking the entry by it discarded a revoke
  // made on another device (#681).
  it('grants the app drives and stamps the grant clock', () => {
    const account = accountWithApp()
    account.setAppPermissions(APP_URL, { drives: [new BatchId(BATCH_HEX)] })
    const app = account.connectedApps[0]
    expect(app.drives !== 'all' && app.drives?.map((b) => b.toHex())).toEqual([BATCH_HEX])
    expect(app.drivesAt).toEqual(expect.any(Number))
  })

  it('clears the grant back to the account default', () => {
    const account = accountWithApp()
    account.setAppPermissions(APP_URL, { drives: [new BatchId(BATCH_HEX)] })
    account.setAppPermissions(APP_URL, { drives: undefined })
    expect(account.connectedApps[0].drives).toBeUndefined()
  })

  it('is a no-op for an unknown app', () => {
    const account = accountWithApp()
    account.setAppPermissions('https://other.example.com', { drives: [new BatchId(BATCH_HEX)] })
    expect(account.connectedApps[0].drives).toBeUndefined()
    expect(account.connectedApps).toHaveLength(1)
  })

  // A removed app reconnects as a first connect, and the picker's default
  // choice writes nothing — so the grant has to go with the Remove, on its own
  // clock, or the app comes back still granted the drives it had.
  it('is forgotten by Remove, with a fresh grant clock', () => {
    const account = accountWithApp()
    account.setAppPermissions(APP_URL, { drives: [new BatchId(BATCH_HEX)] })
    const grantedAt = account.connectedApps[0].drivesAt ?? 0
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(grantedAt + 1)
      account.removeApp(APP_URL)
    } finally {
      vi.useRealTimers()
    }
    const app = account.connectedApps[0]
    expect(app.drives).toBeUndefined()
    expect(app.drivesAt).toBeGreaterThan(grantedAt)
    expect(app.revokedAt).toEqual(expect.any(Number))
  })

  it('survives a plain Disconnect', () => {
    const account = accountWithApp()
    account.setAppPermissions(APP_URL, { drives: [new BatchId(BATCH_HEX)] })
    account.disconnectApp(APP_URL)
    expect(account.connectedApps[0].drives).toHaveLength(1)
  })
})

// The account syncs to its default drive, and a scratch drive overwrites its
// oldest data, so the default is always a regular drive (#862).
// #885: the sharing switches, pinned per app on the grant's clock, or set
// account-wide on the settings clock.
describe('Account sharing switches', () => {
  const APP_URL = 'https://app.example.com'

  function accountWithApp(): Account {
    return new Account(
      {
        ...signedInRecord(),
        connectedApps: [{ appUrl: APP_URL, appName: 'Test App', lastConnectedAt: 1 }],
      },
      noCommit,
    )
  }

  // Each switch on its own clock, not the drives': a drive picked on a stale
  // copy elsewhere must not carry that copy's switches over this pin.
  it("pins and unpins an app, stamping the switch's own clock", () => {
    const account = accountWithApp()
    account.setAppPermissions(APP_URL, { dataSharing: false })
    expect(account.connectedApps[0].dataSharing).toBe(false)
    expect(account.connectedApps[0].dataSharingAt).toEqual(expect.any(Number))
    expect(account.connectedApps[0].drivesAt).toBeUndefined()
    account.setAppPermissions(APP_URL, { dataSharing: undefined })
    expect(account.connectedApps[0].dataSharing).toBeUndefined()
  })

  it("sets the account-wide default on the switch's own clock alone", () => {
    const account = accountWithApp()
    account.setSharingDefault('writeAccess', false)
    expect(account.settings).toEqual({ writeAccess: false, writeAccessAt: expect.any(Number) })
    expect(account.settingsAt).toBeUndefined()
  })

  // The other direction: a switch flipped on a stale copy, after device B
  // changed "Keep apps connected for", must not carry the old length over B's.
  it('a switch flipped on a stale copy does not revert a newer session length', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const account = accountWithApp()
    account.setAppConnectionDays(30)
    now.mockReturnValue(3_000)
    account.setSharingDefault('dataSharing', false)
    account.applyRefreshed({ settings: { appSessionDuration: 5 }, settingsAt: 2_000 })
    now.mockRestore()
    expect(account.settings).toMatchObject({ appSessionDuration: 5, dataSharing: false })
  })

  // Device B, on a stale copy, changes "Keep apps connected for" after this
  // device turned data sharing off: its settings outrank ours whole, and
  // must not take the "off" with them.
  it('folds a remote settings copy per switch, not whole', () => {
    const account = accountWithApp()
    account.setSharingDefault('dataSharing', false)
    const dataSharingAt = account.settings?.dataSharingAt
    account.applyRefreshed({
      settings: { appSessionDuration: 5 },
      settingsAt: (dataSharingAt ?? 0) + 1,
    })
    expect(account.settings).toEqual({ appSessionDuration: 5, dataSharing: false, dataSharingAt })
  })

  it('forgets the pins with Remove, as it forgets the drives', () => {
    const account = accountWithApp()
    account.setAppPermissions(APP_URL, {
      dataSharing: false,
      writeAccess: false,
      sessionDuration: 7,
    })
    account.removeApp(APP_URL)
    expect(account.connectedApps[0].dataSharing).toBeUndefined()
    expect(account.connectedApps[0].writeAccess).toBeUndefined()
    expect(account.connectedApps[0].sessionDuration).toBeUndefined()
  })
})

describe('Account default drive', () => {
  const REGULAR_HEX = 'c'.repeat(64)
  const SCRATCH_HEX = 'e'.repeat(64)
  const drive = (hex: string, kind?: 'scratch') => ({
    batchID: new BatchId(hex),
    signerKey: new PrivateKey('d'.repeat(64)),
    ...(kind && { kind }),
    utilization: 0,
    usable: true,
    depth: 20,
    amount: 100000000n,
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    exists: true,
  })

  it('is the first regular drive added, not an earlier scratch one', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.addStamp(drive(SCRATCH_HEX, 'scratch'))
    expect(account.defaultPostageStampBatchID).toBeUndefined()
    account.addStamp(drive(REGULAR_HEX))
    expect(account.defaultPostageStampBatchID?.toHex()).toBe(REGULAR_HEX)
  })

  it('never falls back to a scratch drive when the default is removed', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.addStamp(drive(REGULAR_HEX))
    account.addStamp(drive(SCRATCH_HEX, 'scratch'))
    account.removeStamp(new BatchId(REGULAR_HEX))
    expect(account.defaultPostageStampBatchID).toBeUndefined()
  })

  it('cannot be set to a scratch drive', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.addStamp(drive(REGULAR_HEX))
    account.addStamp(drive(SCRATCH_HEX, 'scratch'))
    account.setDefaultStamp(new BatchId(SCRATCH_HEX))
    expect(account.defaultPostageStampBatchID?.toHex()).toBe(REGULAR_HEX)
  })
})

describe('Account.setAccess', () => {
  it('swaps the vault while signed in', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.setAccess({ type: 'passkey', credentialId: 'cred' }, 'bbccddee')
    expect(account.accessMethod.type).toBe('passkey')
  })

  it('throws on a signed-out account instead of undoing the sign-out', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.signOut(ENCRYPTED_STATE)
    expect(() =>
      account.setAccess({ type: 'password', kdfSalt: '11', kdfIterations: 100000 }, 'bbccddee'),
    ).toThrow(/signed out/)
    // The sign-out survived, and the original vault is untouched.
    expect(account.isSignedOut).toBe(true)
    expect(account.vault.encryptedSeed).toBe('aabbccdd')
    expect(account.toRecord()).toMatchObject({ signedOutAt: expect.any(Number) })
  })
})

describe('Account.markDeleted', () => {
  const APP_URL = 'https://app.example.com'
  const OTHER_APP_URL = 'https://other.example.com'
  const REVOKED_AT = 1700000000500

  function accountWithApps(commit: (account: Account, options?: { skipSync?: boolean }) => void) {
    return new Account(
      {
        ...signedInRecord(),
        connectedApps: [
          { appUrl: APP_URL, appName: 'App', lastConnectedAt: 1, appSecret: '44'.repeat(32) },
          // Already removed: its tombstone keeps its own clock.
          { appUrl: OTHER_APP_URL, appName: 'Other', lastConnectedAt: 1, revokedAt: REVOKED_AT },
        ],
      },
      commit,
    )
  }

  // Not a published commit: the caller awaits the publish itself, and the
  // apps are only revoked once it has landed.
  it('marks the account deleted in one unpublished commit, leaving its apps', () => {
    const commit = vi.fn()
    const account = accountWithApps(commit)

    account.markDeleted()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(account, { skipSync: true })
    expect(account.deleted).toBe(true)
    expect(account.deletedAt).toEqual(expect.any(Number))
    expect(account.connectedApps[0].revokedAt).toBeUndefined()
    expect(account.toSyncedRecord().deleted).toBe(true)
  })

  it('revokes every live app in one unpublished commit', () => {
    const commit = vi.fn()
    const account = accountWithApps(commit)

    account.revokeAllApps()

    expect(commit).toHaveBeenCalledWith(account, { skipSync: true })
    const [live, removed] = account.connectedApps
    expect(live.revokedAt).toEqual(expect.any(Number))
    expect(live.appSecret).toBeUndefined()
    expect(removed.revokedAt).toBe(REVOKED_AT)
  })

  // Drives stay: the account publishes through its default drive, and the
  // fold skips a removed device's view.
  it('leaves drives and devices alone', () => {
    const account = new Account(
      {
        ...signedInRecord(),
        devices: [{ deviceId: 'd', name: 'd', createdAt: 1, lastSignedInAt: 1 }],
        postageStamps: [
          {
            batchID: new BatchId('c'.repeat(64)),
            signerKey: new PrivateKey('b'.repeat(64)),
            depth: 20,
            amount: 1n,
            bucketDepth: 16,
            blockNumber: 1,
            immutableFlag: false,
            utilization: 0,
            usable: true,
            exists: true,
            createdAt: 1,
          },
        ],
      },
      noCommit,
    )

    account.markDeleted()

    expect(account.stamps).toHaveLength(1)
    expect(account.devices[0].removedAt).toBeUndefined()
  })
})

describe('Account.cancelDeletion', () => {
  // The marker comes off on a clock after the marking, so it outvotes one that
  // reached Swarm; and nothing is published, so a retry's own publish is not
  // contended.
  it('takes the marker back on a newer clock, unpublished', () => {
    const commit = vi.fn()
    const account = new Account(
      {
        ...signedInRecord(),
        connectedApps: [
          {
            appUrl: 'https://app.example.com',
            appName: 'App',
            lastConnectedAt: 1,
            appSecret: '44'.repeat(32),
          },
        ],
      },
      commit,
    )
    account.markDeleted()
    const markedAt = account.deletedAt ?? 0
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(markedAt + 1)
      account.cancelDeletion()
    } finally {
      vi.useRealTimers()
    }
    expect(account.deleted).toBe(false)
    expect(account.deletedAt).toBeGreaterThan(markedAt)
    expect(commit).toHaveBeenLastCalledWith(account, { skipSync: true })
  })
})

describe('Account.applyRefreshed deletion verdict', () => {
  const CREATED_AT = 1700000000000

  it('reports a peer deletion that wins', () => {
    const account = new Account(signedInRecord(), noCommit)
    expect(account.applyRefreshed({ deleted: true, deletedAt: CREATED_AT + 1 })).toBe(true)
    expect(account.deleted).toBe(true)
  })

  it('ignores a deletion older than the local verdict', () => {
    const account = new Account(
      { ...signedInRecord(), deleted: false, deletedAt: CREATED_AT + 10 },
      noCommit,
    )
    expect(account.applyRefreshed({ deleted: true, deletedAt: CREATED_AT + 5 })).toBe(false)
    expect(account.deleted).toBe(false)
  })

  // The deleting device folds peers while it publishes; its own deletion is
  // not news, and a stale peer's live copy must not undo it.
  it('neither reports nor undoes a deletion this device made', () => {
    const account = new Account(signedInRecord(), noCommit)
    account.markDeleted()
    expect(account.applyRefreshed({ deleted: false, deletedAt: CREATED_AT })).toBe(false)
    expect(account.applyRefreshed({ deleted: true, deletedAt: Date.now() + 1 })).toBe(false)
    expect(account.deleted).toBe(true)
  })

  it('takes a newer restore from a peer', () => {
    const account = new Account(
      { ...signedInRecord(), deleted: true, deletedAt: CREATED_AT + 5 },
      noCommit,
    )
    expect(account.applyRefreshed({ deleted: false, deletedAt: CREATED_AT + 10 })).toBe(false)
    expect(account.deleted).toBe(false)
  })
})
