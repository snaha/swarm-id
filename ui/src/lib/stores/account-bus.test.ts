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

import { PUBLISH_DEBOUNCE_MS, accountBusStore } from './account-bus'
import { applyAccountDelta } from './account-delta'

// The fold itself is `account-delta.test.ts`; here the question is only whether
// a peer's message reaches it, and whether folding one publishes anything back.
vi.mock('./account-delta', () => ({ applyAccountDelta: vi.fn() }))

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
      /** What the bus subscribed with — the seam a peer's message arrives on. */
      deliver?: (raw: unknown) => void
    }[],
)
/** Holds the topic derivation open, so "a publish during the join" is a real
 *  window rather than a race the two HMACs would normally win. Unset for every
 *  test that does not care. */
const deriveGate = vi.hoisted(() => ({ value: undefined as Promise<void> | undefined }))
vi.mock('@snaha/swarm-id', async (importActual) => {
  const actual = await importActual<typeof import('@snaha/swarm-id')>()
  return {
    ...actual,
    deriveBusContext: async (derivationKey: string) => {
      await deriveGate.value
      return actual.deriveBusContext(derivationKey)
    },
    SignalingTransport: vi.fn(function (options: { url: string; topic: string }) {
      const transport = {
        options,
        local: false,
        publish: vi.fn(),
        subscribe: vi.fn((handler: (raw: unknown) => void) => {
          transport.deliver = handler
          return () => {
            transport.deliver = undefined
          }
        }),
        close: vi.fn(),
        deliver: undefined as ((raw: unknown) => void) | undefined,
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

/** A well-formed `account-delta` for `accountId`, as a peer would publish it. */
function makeDelta(accountId: string, accountName: string) {
  return {
    type: 'account-delta',
    snapshot: {
      version: 1,
      timestamp: 2_000_000,
      accountId,
      metadata: {
        accountName,
        publicKey: `02${'ab'.repeat(32)}`,
        accountNameAt: 2_000_000,
        createdAt: 1_000_000,
        lastModified: 2_000_000,
        devices: [],
        partitionCount: 1,
      },
      connectedApps: [],
      postageStamps: [],
    },
  }
}

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
 *  before the timer would have fired proves nothing, so this is derived from
 *  the store's own constant rather than a number that can drift behind it. */
const settlePublish = () => new Promise((resolve) => setTimeout(resolve, PUBLISH_DEBOUNCE_MS + 100))

describe('accountBusStore', () => {
  beforeEach(() => {
    accountBusStore.leave()
    vi.mocked(applyAccountDelta).mockClear()
    transports.length = 0
    signalingUrlStub.value = SIGNALING_URL
    deriveGate.value = undefined
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

  // The debounce holds ONE pending account. A commit for another account
  // landing in the same window used to overwrite it, and the publish-time guard
  // then dropped the intruder — losing the joined account's delta rather than
  // ignoring the other one's. A revoke is what goes missing.
  it('keeps the joined account pending when another account commits in the same window', async () => {
    const account = makeAccount()
    accountBusStore.join(account)
    await settle()

    accountBusStore.publish(account)
    accountBusStore.publish(
      makeAccount({
        id: new EthAddress('bb'.repeat(20)),
        derivationKey: OTHER_DERIVATION_KEY,
      }),
    )
    await settlePublish()

    const published = transports[0].publish.mock.calls.map(([message]) => message)
    expect(published).toHaveLength(1)
    expect(published[0].snapshot.accountId).toBe(account.id.toHex())
  })

  // Joining derives the topic, which is async. A revoke committed right after
  // an account is selected falls in that window, and a publish dropped there is
  // never re-sent — the next mutation is the earliest the iframe hears anything.
  it('publishes a commit that lands while the join is still deriving', async () => {
    let openGate = () => {}
    deriveGate.value = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const account = makeAccount()

    accountBusStore.join(account)
    accountBusStore.publish(account)
    await settlePublish()
    openGate()
    await settle()

    expect(transports).toHaveLength(1)
    expect(transports[0].publish).toHaveBeenCalledTimes(1)
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
  // #608: the tab publishes AND consumes. A peer's delta has to reach the fold
  // — this is the wiring that did not exist while the store was publish-only.
  it('folds a delta a peer publishes into the room', async () => {
    accountBusStore.join(makeAccount())
    await settle()

    transports[0].deliver?.(makeDelta('aa'.repeat(20), 'Renamed On Another Device'))

    expect(applyAccountDelta).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'aa'.repeat(20) }),
    )
    // Folding is not a change of ours: echoing it back is a loop between two
    // devices that never settles.
    await settlePublish()
    expect(transports[0].publish).not.toHaveBeenCalled()
  })

  // Malformed or unknown traffic is dropped by the bus's own schema — the fold
  // must never see it, since it writes durable storage.
  it('does not fold traffic that is not a delta', async () => {
    accountBusStore.join(makeAccount())
    await settle()

    transports[0].deliver?.({ type: 'account-delta', snapshot: { nope: true } })
    transports[0].deliver?.({ type: 'lease-request', accountId: 'aa'.repeat(20) })

    expect(applyAccountDelta).not.toHaveBeenCalled()
  })

  // The room's keys scope it to ONE account. A peer holding them that names a
  // different account is writing outside that scope — and the account it names
  // may well be co-resident on this device, where the fold would rename it,
  // tombstone its apps or add stamps to it. The proxy drops the same mismatch.
  it('does not fold a delta that names a different account', async () => {
    accountBusStore.join(makeAccount())
    await settle()

    transports[0].deliver?.(makeDelta('bb'.repeat(20), 'Another Account Entirely'))

    expect(applyAccountDelta).not.toHaveBeenCalled()
  })

  it('stops folding once the room is left', async () => {
    accountBusStore.join(makeAccount())
    await settle()
    const room = transports[0]
    accountBusStore.leave()

    room.deliver?.(makeDelta('aa'.repeat(20), 'After Leaving'))

    expect(applyAccountDelta).not.toHaveBeenCalled()
  })

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
