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
import type { SyncedAccount } from '@snaha/swarm-id'
import { describe, expect, it } from 'vitest'

import { partitionHandoverAccount } from '$lib/connect-handshake'

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
        postageStampBatchID: appBatch,
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
  it('hands over only the stamps this app can spend', () => {
    const payload = partitionHandoverAccount(makeAccount(new BatchId(APP_BATCH)), APP_ORIGIN)

    expect(batchIds(payload).sort()).toEqual([APP_BATCH, DEFAULT_BATCH].sort())
    expect(batchIds(payload)).not.toContain(UNRELATED_BATCH)
  })

  it('hands over only the default when the app has no override', () => {
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
})
