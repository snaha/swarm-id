// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What the connect popup hands a PARTITIONED proxy iframe.
 *
 * Since #547 that session is a first-class writer, so the handover carries real
 * credentials — in a context embedded by an arbitrary dApp page. It can only
 * ever spend the stamp resolved for it, so that is all it should be given
 * (#578).
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import { AuthDataSchema, type ConnectedApp, type SyncedAccount } from '@snaha/swarm-id/internal'
import { describe, expect, it, vi } from 'vitest'

import { commitConnect, partitionHandoverAccount } from '$lib/connect-handshake'
import type { Account } from '$lib/types'

const APP_ORIGIN = 'https://dapp.example.com'
const DEFAULT_BATCH = 'cc'.repeat(32)
const APP_BATCH = 'dd'.repeat(32)
const UNRELATED_BATCH = 'ee'.repeat(32)

function stamp(batchIdHex: string, signerHex: string) {
  return {
    batchID: new BatchId(batchIdHex),
    signerKey: new PrivateKey(signerHex),
    utilization: 0,
    usable: true,
    depth: 24,
    amount: BigInt(100),
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    exists: true,
    createdAt: 1_000_000,
  }
}

function makeAccount(appBatch?: BatchId): SyncedAccount {
  return {
    id: new EthAddress('aa'.repeat(20)),
    name: 'Test Account',
    createdAt: 1_000_000,
    derivationKey: '11'.repeat(32),
    publicKey: `02${'ab'.repeat(32)}`,
    defaultPostageStampBatchID: new BatchId(DEFAULT_BATCH),
    devices: [],
    connectedApps: [
      {
        appUrl: APP_ORIGIN,
        appName: 'dApp',
        lastConnectedAt: 1_000_000,
        drives: appBatch && [appBatch],
      },
    ],
    postageStamps: [
      stamp(DEFAULT_BATCH, '22'.repeat(32)),
      stamp(APP_BATCH, '33'.repeat(32)),
      stamp(UNRELATED_BATCH, '44'.repeat(32)),
    ],
    settings: undefined,
    lastModified: 1_000_000,
    partitionCount: 2,
  } as SyncedAccount
}

const batchIds = (payload: Record<string, unknown>): string[] =>
  (payload.postageStamps as { batchID: string }[]).map((s) => s.batchID)

describe('partitionHandoverAccount', () => {
  // A list grant names exactly what the app may spend: not even the account
  // default rides along when the grant does not name it (#862).
  it('hands over only the drives the app was granted', () => {
    const payload = partitionHandoverAccount(makeAccount(new BatchId(APP_BATCH)), APP_ORIGIN)

    expect(batchIds(payload)).toEqual([APP_BATCH])
  })

  it('hands over only the default when the app has no grant', () => {
    const payload = partitionHandoverAccount(makeAccount(), APP_ORIGIN)

    expect(batchIds(payload)).toEqual([DEFAULT_BATCH])
  })

  // An app connecting for the first time has no `connectedApps` entry yet — the
  // account default is the whole answer, and nothing else may ride along.
  it('hands over only the default for an app with no entry yet', () => {
    const payload = partitionHandoverAccount(makeAccount(), 'https://other.example.com')

    expect(batchIds(payload)).toEqual([DEFAULT_BATCH])
  })

  // Everything else the synced projection carries is still needed: the topic
  // and envelope key of the account bus, and the lock-SOC signer of the
  // partition lease, all derive from `derivationKey`.
  it('still carries the derivation key and strips app secrets', () => {
    const payload = partitionHandoverAccount(makeAccount(), APP_ORIGIN)

    expect(payload.derivationKey).toBe('11'.repeat(32))
    for (const app of payload.connectedApps as Record<string, unknown>[]) {
      expect(app.appSecret).toBeUndefined()
    }
  })

  // The proxy REFUSES a handover whose account does not parse, so a narrowing
  // that quietly drops a required field no longer degrades the session — it
  // ends it. Nothing else checks this sender against that receiver, and the
  // JSON round-trip in `sendSecretToOpener` is part of the wire shape, so the
  // assertion runs on what actually crosses the boundary.
  it('produces an account the proxy will accept', () => {
    const wire = JSON.parse(
      JSON.stringify({
        secret: '33'.repeat(32),
        account: partitionHandoverAccount(makeAccount(new BatchId(APP_BATCH)), APP_ORIGIN),
      }),
    )

    expect(AuthDataSchema.safeParse(wire).success).toBe(true)
  })
})

// The popup may have been opened by the app page rather than the iframe —
// Firefox refuses the iframe a popup on the parent's click (#751). The
// handover then goes to the opener AND to each of its frames: only the one on
// this origin receives it, and only the challenge lets the proxy take it.
describe('commitConnect handover', () => {
  it('posts the session to the opener and to every frame of the opener', () => {
    const openerPost = vi.fn()
    const framePosts = [vi.fn(), vi.fn()]
    vi.stubGlobal('window', {
      addEventListener: () => {},
      location: { origin: 'https://id.example.com' },
      opener: {
        postMessage: openerPost,
        length: 2,
        0: { postMessage: framePosts[0] },
        1: { postMessage: framePosts[1] },
      },
    })
    const account = {
      ...makeAccount(),
      settings: undefined,
      connectApp: vi.fn(),
      toSyncedRecord: () => makeAccount(),
    } as unknown as Account
    try {
      commitConnect(
        account,
        { appOrigin: APP_ORIGIN, appName: 'dApp', partitionChallenge: 'attempt-7' },
        '33'.repeat(32),
      )
    } finally {
      vi.unstubAllGlobals()
    }

    const expected = [
      expect.objectContaining({ type: 'setSecret', challenge: 'attempt-7' }),
      'https://id.example.com',
    ]
    expect(openerPost).toHaveBeenCalledWith(...expected)
    for (const post of framePosts) expect(post).toHaveBeenCalledWith(...expected)
  })
})

// The connection's deadline: the app's own session length (#885) over the
// account's; and the grant made on the connect screen, each field on its
// own clock.
describe('commitConnect', () => {
  const NOW = 1_000_000
  const connect = (existing: Partial<ConnectedApp>) => {
    const saved: ConnectedApp[] = []
    const account = {
      settings: { appSessionDuration: 500 },
      connectedApps: [{ appUrl: APP_ORIGIN, appName: 'dApp', lastConnectedAt: 1, ...existing }],
      connectApp: (app: ConnectedApp) => saved.push(app),
    } as unknown as Account
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(NOW)
      commitConnect(account, { appOrigin: APP_ORIGIN, appName: 'dApp' }, '33'.repeat(32), {
        dataSharing: true,
      })
    } finally {
      vi.useRealTimers()
    }
    return saved[0]
  }

  it("lasts the app's own session length when it has one, else the account's", () => {
    expect(connect({ sessionDuration: 7 }).connectedUntil).toBe(NOW + 7)
    expect(connect({}).connectedUntil).toBe(NOW + 500)
  })

  it("stamps the clock of each switch granted, not the drives'", () => {
    const connection = connect({})
    expect(connection).toMatchObject({ dataSharing: true, dataSharingAt: NOW })
    expect(connection.drivesAt).toBeUndefined()
  })
})
