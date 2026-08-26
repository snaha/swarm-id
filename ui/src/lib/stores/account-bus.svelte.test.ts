// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The SwarmID tab's half of `account-delta` (docs/Account-Bus.md): it is where
 * a revoke happens, and the only context that can tell a partitioned iframe
 * about one — the tab and the iframe are in different storage partitions, so
 * nothing local crosses between them.
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import type { SignedInAccount } from '@snaha/swarm-id'
import { deriveBusContext } from '@snaha/swarm-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { accountBusStore } from './account-bus.svelte'

const SIGNALING_URL = 'ws://signaling.test'
const signalingUrlStub = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock('$lib/bus-signaling-url', () => ({
  busSignalingUrl: () => signalingUrlStub.value,
}))

/** The transport opens a real WebSocket; only its construction matters here. */
const transports = vi.hoisted(
  () =>
    [] as {
      options: { url: string; topic: string }
      publish: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }[],
)
vi.mock('@snaha/swarm-id', async (importActual) => {
  const actual = await importActual<typeof import('@snaha/swarm-id')>()
  return {
    ...actual,
    SignalingTransport: vi.fn(function (options: { url: string; topic: string }) {
      const transport = {
        options,
        local: false,
        publish: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      }
      transports.push(transport)
      return transport
    }),
  }
})

const DERIVATION_KEY = '11'.repeat(32)
const OTHER_DERIVATION_KEY = '99'.repeat(32)
const BATCH_ID_HEX = 'cc'.repeat(32)
const APP_SECRET = '44'.repeat(32)

function makeAccount(overrides?: Partial<SignedInAccount>): SignedInAccount {
  return {
    id: new EthAddress('aa'.repeat(20)),
    name: 'Test Account',
    createdAt: 1_000_000,
    derivationKey: DERIVATION_KEY,
    publicKey: `02${'ab'.repeat(32)}`,
    defaultPostageStampBatchID: new BatchId(BATCH_ID_HEX),
    devices: [],
    connectedApps: [
      {
        appUrl: 'https://dapp.example.com',
        appName: 'dApp',
        lastConnectedAt: 1_000_000,
        appSecret: APP_SECRET,
        connectedUntil: 2_000_000,
      },
    ],
    postageStamps: [
      {
        batchID: new BatchId(BATCH_ID_HEX),
        signerKey: new PrivateKey('22'.repeat(32)),
        utilization: 0,
        usable: true,
        depth: 24,
        amount: BigInt(100),
        bucketDepth: 16,
        blockNumber: 1,
        immutableFlag: false,
        exists: true,
        createdAt: 1_000_000,
      },
    ],
    settings: undefined,
    lastModified: 1_000_000,
    partitionCount: 2,
    access: { type: 'password', kdfSalt: 'ab'.repeat(16), kdfIterations: 100_000 },
    encryptedSeed: '00'.repeat(48),
    ...overrides,
  } as SignedInAccount
}

/** The join derives a topic (two HMACs + importKey), so it is not synchronous. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
/** Past the publish debounce — a "did not publish" assertion that resolves
 *  before the timer would have fired proves nothing. */
const settlePublish = () => new Promise((resolve) => setTimeout(resolve, 400))

describe('accountBusStore', () => {
  beforeEach(() => {
    accountBusStore.leave()
    transports.length = 0
    signalingUrlStub.value = SIGNALING_URL
  })

  it('joins the account-derived room, not one named by the account id', async () => {
    const account = makeAccount()
    accountBusStore.join(account)
    await settle()

    const { topic } = await deriveBusContext(DERIVATION_KEY)
    expect(transports).toHaveLength(1)
    expect(transports[0].options).toMatchObject({ url: SIGNALING_URL, topic })
    expect(topic).not.toContain(account.id.toHex())
  })

  // The wire form carries no session material: a receiver may be an iframe
  // embedded by an arbitrary dApp, which must not learn another dApp's secret.
  it('publishes a delta with no app secret on it', async () => {
    const account = makeAccount()
    accountBusStore.join(account)
    await settle()

    accountBusStore.publish(account)
    await settlePublish()

    const published = transports[0].publish.mock.calls.map(([message]) => message)
    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('account-delta')
    for (const app of published[0].snapshot.connectedApps) {
      expect(app.appSecret).toBeUndefined()
      expect(app.connectedUntil).toBeUndefined()
    }
  })

  // Every account has its own room. Publishing one account's state into
  // another's is the cross-account leak the derived topic exists to prevent.
  it('does not publish an account it has not joined', async () => {
    accountBusStore.join(makeAccount())
    await settle()

    accountBusStore.publish(
      makeAccount({
        id: new EthAddress('bb'.repeat(20)),
        derivationKey: OTHER_DERIVATION_KEY,
      }),
    )
    await settlePublish()

    expect(transports[0].publish).not.toHaveBeenCalled()
  })

  it('closes the previous room when the account switches', async () => {
    accountBusStore.join(makeAccount())
    await settle()

    accountBusStore.join(
      makeAccount({
        id: new EthAddress('bb'.repeat(20)),
        derivationKey: OTHER_DERIVATION_KEY,
      }),
    )
    await settle()

    expect(transports).toHaveLength(2)
    expect(transports[0].close).toHaveBeenCalled()
    expect(transports[0].options.topic).not.toBe(transports[1].options.topic)
  })

  // A build with no bus server (GitHub Pages, plain `pnpm dev`) has no
  // cross-partition channel to reach at all — publishing must be a quiet no-op,
  // not a crash on every account mutation.
  it('is inert when no signaling server is configured', async () => {
    signalingUrlStub.value = undefined
    const account = makeAccount()

    accountBusStore.join(account)
    await settle()
    expect(() => accountBusStore.publish(account)).not.toThrow()
    await settlePublish()

    expect(transports).toHaveLength(0)
  })
})
