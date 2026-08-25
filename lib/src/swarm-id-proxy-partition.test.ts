// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-partitioning write enablement (docs/Account-Bus.md, phase 3): a
 * `setSecret` popup payload carrying the synced-account projection hydrates
 * the proxy into a first-class writer; the legacy secret-only payload stays
 * download-only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

/**
 * The single stamper the mocked `create` hands back, so a test can move the
 * bound slot lane (`currentPartition` / `partitionCount`) and observe the
 * utilization deltas the proxy folds in.
 */
const stamperStub = vi.hoisted(() => ({
  currentPartition: 0 as number | undefined,
  partitionCount: 2,
  applyUtilizationUpdate: vi.fn(),
}))

// Stub the stamper/store/coordinator machinery so `initializeStamper` can run
// without IndexedDB or network access.
vi.mock("./utils/batch-utilization", async (importActual) => {
  const actual =
    await importActual<typeof import("./utils/batch-utilization")>()
  return {
    ...actual,
    UtilizationAwareStamper: {
      create: vi.fn((_signerKey: string, batchId: unknown) =>
        Promise.resolve(
          Object.assign(stamperStub, { mock: "stamper", batchId }),
        ),
      ),
    },
  }
})
vi.mock("./storage/utilization-store", () => ({
  UtilizationStoreDB: vi.fn(function () {
    return {}
  }),
}))
// The signaling transport opens a real WebSocket; the tests only assert that
// the proxy attaches one (and with which topic).
vi.mock("./bus/signaling-transport", () => ({
  SignalingTransport: vi.fn(function (options: unknown) {
    return {
      options,
      publish: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      close: vi.fn(),
    }
  }),
}))
/** Devices the mocked `readRoster` reports for the account's Swarm roster. */
const rosterDevices = vi.hoisted(
  () => [] as { deviceId: string; createdAt: number; lastSignedInAt: number }[],
)
vi.mock("./sync", async (importActual) => {
  const actual = await importActual<typeof import("./sync")>()
  return { ...actual, readRoster: vi.fn(async () => rosterDevices) }
})
vi.mock("./sync/batch-write-coordinator", () => ({
  BatchWriteCoordinator: vi.fn(function (deps: unknown) {
    return {
      deps,
      startLease: vi.fn(),
      teardown: vi.fn(),
      withWrite: vi.fn(),
      yieldForPeer: vi.fn(async () => 1),
      notifySlotMaybeFree: vi.fn(),
      currentPartition: undefined,
    }
  }),
}))

import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"

import { SwarmIdProxy } from "./swarm-id-proxy"
import type { ProxyConfig } from "./swarm-id-proxy"
import { SignalingTransport } from "./bus/signaling-transport"
import { deriveBusContext } from "./bus/bus-context"
import { BatchWriteCoordinator } from "./sync/batch-write-coordinator"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import {
  serializeAccount,
  serializeSyncedAccount,
} from "./utils/storage-managers"
import { STORAGE_CHALLENGE_KEY, STORAGE_KEY_ACCOUNTS } from "./types"
import { DEFAULT_BEE_NODE_URL } from "./schemas"
import type { SignedInAccount, SyncedAccount } from "./schemas"

const PARENT_ORIGIN = "https://dapp.example.com"
const ID_ORIGIN = "https://id.example.com"
const BATCH_ID_HEX = "cc".repeat(32)

type MessageListener = (event: MessageEvent) => Promise<void>

function makeLocalStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

function makeSyncedAccount(): SyncedAccount {
  return {
    id: new EthAddress("aa".repeat(20)),
    name: "Partition Test Account",
    createdAt: 1_000_000,
    derivationKey: "11".repeat(32),
    publicKey: `02${"ab".repeat(32)}`,
    defaultPostageStampBatchID: new BatchId(BATCH_ID_HEX),
    devices: [],
    connectedApps: [],
    postageStamps: [
      {
        batchID: new BatchId(BATCH_ID_HEX),
        signerKey: new PrivateKey("22".repeat(32)),
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
  }
}

describe("SwarmIdProxy partitioned write enablement", () => {
  let parentWindow: { postMessage: ReturnType<typeof vi.fn> }
  let messageListener: MessageListener
  let localStorageFake: Storage
  let proxy: SwarmIdProxy

  /** (Re)create the proxy under a fresh window mock; keeps `localStorageFake`. */
  function mountProxy(config?: ProxyConfig): void {
    const listeners: Record<string, unknown> = {}
    const mockWindow = {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      parent: parentWindow,
      location: { origin: ID_ORIGIN, pathname: "/proxy" },
      localStorage: localStorageFake,
      open: vi.fn(() => ({}) as Window),
      screen: { width: 1920, height: 1080 },
    }
    vi.stubGlobal("window", mockWindow)
    vi.stubGlobal("localStorage", localStorageFake)

    proxy = new SwarmIdProxy(config)
    messageListener = listeners["message"] as MessageListener
  }

  beforeEach(() => {
    vi.restoreAllMocks()

    parentWindow = { postMessage: vi.fn() }
    localStorageFake = makeLocalStorage()
    mountProxy()
  })

  // Each proxy subscribes the shared BroadcastChannel bus; without a destroy a
  // previous test's proxy keeps answering this test's bus traffic.
  afterEach(() => {
    proxy.destroy()
  })

  const dispatch = (data: unknown, origin: string, source: unknown = {}) =>
    messageListener({ data, origin, source } as MessageEvent)

  const messagesOfType = (type: string) =>
    parentWindow.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === type)

  /** Run identify → connect → return the partition challenge the popup echoes. */
  async function startPartitionedConnect(): Promise<string> {
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )
    await dispatch(
      { type: "connect", requestId: "r2" },
      PARENT_ORIGIN,
      parentWindow,
    )
    const challenge = localStorageFake.getItem(STORAGE_CHALLENGE_KEY)
    expect(challenge).toBeTruthy()
    return challenge!
  }

  async function sendSetSecret(
    challenge: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await dispatch(
      {
        type: "setSecret",
        appOrigin: PARENT_ORIGIN,
        challenge,
        data: { secret: "33".repeat(32), ...data },
      },
      ID_ORIGIN,
    )
  }

  it("stays download-only on the legacy secret-only payload", async () => {
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      identityId: "aa".repeat(20),
      identityName: "Legacy",
      identityAddress: "aa".repeat(20),
    })

    expect(messagesOfType("authSuccess")).toHaveLength(1)
    const infos = messagesOfType("connectionInfoChanged")
    const last = infos[infos.length - 1]
    expect(last.storagePartitioned).toBe(true)
    expect(last.uploadMode).toBe("unavailable")
    expect(last.canUpload).toBe(false)
  })

  it("becomes a first-class writer when the payload carries the synced account", async () => {
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(account),
    })

    expect(messagesOfType("authSuccess")).toHaveLength(1)
    const infos = messagesOfType("connectionInfoChanged")
    const last = infos[infos.length - 1]
    // Still surfaced as partitioned (UI messaging), but a full writer.
    expect(last.storagePartitioned).toBe(true)
    expect(last.uploadMode).toBe("user-stamp")
    expect(last.canUpload).toBe(true)
    expect(last.identity?.name).toBe("Partition Test Account")

    // The default stamp was bound from the hydrated account view.
    const createCalls = vi.mocked(UtilizationAwareStamper.create).mock.calls
    expect(createCalls.length).toBeGreaterThanOrEqual(1)
    expect(String(createCalls[0][1])).toBe(BATCH_ID_HEX)
  })

  it("answers a bus lease-request by yielding and announcing the release", async () => {
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, { account: serializeSyncedAccount(account) })

    const coordinator = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as {
      yieldForPeer: ReturnType<typeof vi.fn>
      notifySlotMaybeFree: ReturnType<typeof vi.fn>
    }
    const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
    const published: Record<string, unknown>[] = []
    busChannel.onmessage = (event) =>
      published.push(event.data as Record<string, unknown>)
    try {
      busChannel.postMessage({
        type: "lease-request",
        accountId: "aa".repeat(20),
        fromDeviceId: "peer-device",
      })
      await vi.waitFor(() =>
        expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1),
      )
      // The yielded partition (1, from the mock) is announced to peers.
      await vi.waitFor(() =>
        expect(
          published.filter((m) => m.type === "lease-released"),
        ).toHaveLength(1),
      )
      const released = published.find((m) => m.type === "lease-released")!
      expect(released.partition).toBe(1)
      expect(released.accountId).toBe("aa".repeat(20))

      // A released announcement from a peer wakes the slot wait.
      busChannel.postMessage({
        type: "lease-released",
        accountId: "aa".repeat(20),
        partition: 0,
        fromDeviceId: "peer-device",
      })
      await vi.waitFor(() =>
        expect(coordinator.notifySlotMaybeFree).toHaveBeenCalledTimes(1),
      )
    } finally {
      busChannel.close()
    }
  })

  it("announces the released partition when a teardown drops a held lease", async () => {
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, { account: serializeSyncedAccount(account) })

    const coordinator = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as { currentPartition: number | undefined }
    coordinator.currentPartition = 2

    const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
    const published: Record<string, unknown>[] = []
    busChannel.onmessage = (event) =>
      published.push(event.data as Record<string, unknown>)
    try {
      // A closing tab must wake waiters immediately; otherwise they sleep out
      // the full poll interval the bus exists to skip.
      proxy.destroy()
      await vi.waitFor(() =>
        expect(
          published.filter((m) => m.type === "lease-released"),
        ).toHaveLength(1),
      )
      expect(published[0].partition).toBe(2)
      expect(published[0].accountId).toBe("aa".repeat(20))
    } finally {
      busChannel.close()
    }
  })

  it("ignores its own lease messages and other accounts' messages", async () => {
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, { account: serializeSyncedAccount(account) })

    const coordinator = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as {
      yieldForPeer: ReturnType<typeof vi.fn>
      notifySlotMaybeFree: ReturnType<typeof vi.fn>
    }
    const ownDeviceId = localStorageFake.getItem("swarm-id-device-id")
    expect(ownDeviceId).toBeTruthy()
    const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
    try {
      // Own echo (same deviceId) and a foreign account: both ignored.
      busChannel.postMessage({
        type: "lease-request",
        accountId: "aa".repeat(20),
        fromDeviceId: ownDeviceId,
      })
      busChannel.postMessage({
        type: "lease-request",
        accountId: "bb".repeat(20),
        fromDeviceId: "peer-device",
      })
      busChannel.postMessage({
        type: "lease-released",
        accountId: "bb".repeat(20),
        partition: 0,
        fromDeviceId: "peer-device",
      })
      // A matching request afterwards proves the earlier ones were dropped
      // (not merely still in flight).
      busChannel.postMessage({
        type: "lease-request",
        accountId: "aa".repeat(20),
        fromDeviceId: "peer-device",
      })
      await vi.waitFor(() =>
        expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1),
      )
      expect(coordinator.notifySlotMaybeFree).not.toHaveBeenCalled()
    } finally {
      busChannel.close()
    }
  })

  // `buckets` carry the PER-PARTITION counter `j`, not an absolute slot, so a
  // delta is only foldable by a context bound to the same slot lane. The bus
  // reaches other devices — which hold OTHER partitions of the same batch — so
  // the lane must be on the wire and checked on receive.
  describe("utilization deltas are lane-scoped", () => {
    const LANE_BUCKETS = [{ index: 7, value: 900 }]
    const OWN_BUCKETS = [{ index: 7, value: 6 }]

    /**
     * Deps of the coordinator the LIVE proxy built. The mock accumulates a
     * result per construction across the whole file, and every earlier one is
     * bound to a proxy that has since been destroyed (closed bus, no stamper),
     * so calling into those hooks silently does nothing.
     */
    function liveCoordinatorDeps(): {
      onLeaseAcquired: (partition: number) => void
      flushStamperState: () => Promise<void>
    } {
      const results = vi.mocked(BatchWriteCoordinator).mock.results
      const latest = results[results.length - 1]
      expect(latest?.type).toBe("return")
      return (
        latest.value as {
          deps: {
            onLeaseAcquired: (partition: number) => void
            flushStamperState: () => Promise<void>
          }
        }
      ).deps
    }

    async function hydrateOnLane(partition: number): Promise<void> {
      stamperStub.currentPartition = partition
      stamperStub.partitionCount = 2
      stamperStub.applyUtilizationUpdate.mockClear()
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(makeSyncedAccount()),
      })
    }

    it("drops a delta from a peer holding a different partition", async () => {
      await hydrateOnLane(0)
      const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
      try {
        // A peer device on partition 1 is far ahead in ITS lane. Folding its
        // `j` in would skip ~900 of our own partition-0 slots and publish that
        // as partition 0's durable resume counter.
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 1,
          partitionCount: 2,
          buckets: LANE_BUCKETS,
        })
        // A same-lane delta afterwards proves the first was dropped, not
        // merely still in flight.
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: OWN_BUCKETS,
        })
        await vi.waitFor(() =>
          expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
        expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledWith(
          OWN_BUCKETS,
        )
      } finally {
        busChannel.close()
      }
    })

    it("drops a delta from a peer on a different partition count", async () => {
      await hydrateOnLane(0)
      const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
      try {
        // Same partition index, different split: `j` maps to a different slot
        // under `partitionCount + partition + partitionCount·j`.
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 4,
          buckets: LANE_BUCKETS,
        })
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: OWN_BUCKETS,
        })
        await vi.waitFor(() =>
          expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
        expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledWith(
          OWN_BUCKETS,
        )
      } finally {
        busChannel.close()
      }
    })

    // An unbound stamper cannot judge a lane yet, but the lane it is ABOUT to
    // bind may be exactly the one the delta carries. Dropping it loses it for
    // good: the coordinator's adopt fast path re-binds from this tab's own
    // in-memory counters (`buildLeaseLocalCounter`), not from durable state, so
    // a sibling tab's writes would be invisible and we would re-issue slots it
    // already consumed.
    it("holds a delta received while unbound and folds it in on lease acquire", async () => {
      await hydrateOnLane(0)
      // Between leases: no lane to compare against.
      stamperStub.currentPartition = undefined
      const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
      try {
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: [{ index: 7, value: 6 }],
        })
        // A second delta for the same lane merges (max per bucket) rather than
        // replacing — both writes have to survive the unbound window.
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: [
            { index: 7, value: 4 },
            { index: 9, value: 11 },
          ],
        })
        // A different lane's delta must not leak into the buffer.
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 1,
          partitionCount: 2,
          buckets: [{ index: 7, value: 900 }],
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(stamperStub.applyUtilizationUpdate).not.toHaveBeenCalled()

        // The bind names our lane; the coordinator fires `onLeaseAcquired`.
        stamperStub.currentPartition = 0
        liveCoordinatorDeps().onLeaseAcquired(0)

        expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1)
        expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledWith([
          { index: 7, value: 6 },
          { index: 9, value: 11 },
        ])
      } finally {
        busChannel.close()
      }
    })

    // The buckets are captured before `flush()`; the lane must be too. Reading
    // it after the await lets a teardown landing mid-flush relabel
    // partition-p counters as the legacy `{0, 1}` lane — which every
    // momentarily-unbound peer then folds, the exact skip the guard prevents.
    it("labels a published delta with the lane held before the flush", async () => {
      await hydrateOnLane(1)
      const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
      const seen: { partition: number; partitionCount: number }[] = []
      busChannel.onmessage = (event) => seen.push(event.data)
      try {
        Object.assign(stamperStub, {
          getBucketUpdatesForBroadcast: () => [{ index: 7, value: 6 }],
          flush: async () => {
            // A teardown lands while the flush is in flight: `unbindPartition`
            // clears the partition AND resets the count to 1.
            stamperStub.currentPartition = undefined
            stamperStub.partitionCount = 1
          },
        })

        await liveCoordinatorDeps().flushStamperState()

        await vi.waitFor(() => expect(seen).toHaveLength(1))
        expect(seen[0]).toMatchObject({ partition: 1, partitionCount: 2 })
      } finally {
        busChannel.close()
      }
    })

    it("discards the buffer when the bind lands on a different lane", async () => {
      await hydrateOnLane(0)
      stamperStub.currentPartition = undefined
      const busChannel = new BroadcastChannel("swarm-id-bus-v1:origin")
      try {
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: LANE_BUCKETS,
        })
        await new Promise((resolve) => setTimeout(resolve, 20))

        // We ended up on partition 1 instead — partition 0's counters are not
        // ours to fold.
        stamperStub.currentPartition = 1
        liveCoordinatorDeps().onLeaseAcquired(1)

        expect(stamperStub.applyUtilizationUpdate).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })
  })

  // The partition-intent round and the idle-yield both read `knownDeviceIds`.
  // In a partitioned iframe shared storage is invisible, so the roster has to
  // fold into the hydrated account view or a Safari writer stays blind to every
  // peer that signs in after connect.
  it("folds the Swarm roster into the hydrated partition account", async () => {
    const peer = {
      deviceId: "peer-device-from-roster",
      createdAt: Date.now(),
      lastSignedInAt: Date.now(),
    }
    rosterDevices.length = 0
    rosterDevices.push(peer)

    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(makeSyncedAccount()),
    })

    const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as {
      deps: {
        knownDeviceIds: () => string[]
        refreshKnownDeviceIds: () => Promise<void>
      }
    }
    expect(deps.knownDeviceIds()).not.toContain(peer.deviceId)

    await deps.refreshKnownDeviceIds()

    expect(deps.knownDeviceIds()).toContain(peer.deviceId)
  })

  // Hydration must go through the same network-settings path as the storage-
  // backed one: an RPC-only difference is invisible to a `beeNodeUrl` guard,
  // and a partitioned session that keeps the default RPC reads stamp TTLs and
  // the postage contract off the wrong chain.
  it("applies hydrated network settings when only the rpc url differs", async () => {
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(makeSyncedAccount()),
      networkSettings: {
        beeNodeUrl: DEFAULT_BEE_NODE_URL,
        gnosisRpcUrl: "https://rpc.example.test/",
      },
    })

    const internals = proxy as unknown as { gnosisRpcUrl: string }
    expect(internals.gnosisRpcUrl).toBe("https://rpc.example.test/")
  })

  it("rejects a hydration payload with a wrong challenge", async () => {
    const account = makeSyncedAccount()
    await startPartitionedConnect()
    await sendSetSecret("not-the-challenge", {
      account: serializeSyncedAccount(account),
    })

    expect(messagesOfType("authSuccess")).toHaveLength(0)
  })

  // The cross-partition/cross-device transport is what makes the bus more than
  // a same-partition BroadcastChannel. Every path that resolves a connection
  // must attach it — the unpartitioned ones too, or the bus only ever exists
  // on Safari (docs/Account-Bus.md, phase 2).
  describe("account-bus signaling transport", () => {
    const SIGNALING_URL = "ws://signaling.test"

    /** Seed shared storage with an account already connected to the dApp. */
    function seedConnectedAccount(): SyncedAccount {
      const synced = makeSyncedAccount()
      const stored: SignedInAccount = {
        ...synced,
        connectedApps: [
          {
            appUrl: PARENT_ORIGIN,
            appName: "dApp",
            appSecret: "44".repeat(32),
            lastConnectedAt: Date.now(),
            connectedUntil: Date.now() + 60_000,
          },
        ],
        // Inert but schema-valid: the vault is never opened here.
        access: {
          type: "password",
          kdfSalt: "ab".repeat(16),
          kdfIterations: 100_000,
        },
        encryptedSeed: "00".repeat(48),
      }
      localStorageFake.setItem(
        STORAGE_KEY_ACCOUNTS,
        JSON.stringify({ version: 1, data: [serializeAccount(stored)] }),
      )
      return synced
    }

    async function remountWithSignaling(): Promise<void> {
      proxy.destroy()
      vi.mocked(SignalingTransport).mockClear()
      mountProxy({ signalingUrl: SIGNALING_URL })
    }

    it("attaches on a first authentication from shared storage", async () => {
      const synced = seedConnectedAccount()
      await remountWithSignaling()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )

      await vi.waitFor(() =>
        expect(SignalingTransport).toHaveBeenCalledTimes(1),
      )
      const { topic } = await deriveBusContext(synced.derivationKey)
      expect(vi.mocked(SignalingTransport).mock.calls[0][0]).toMatchObject({
        url: SIGNALING_URL,
        topic,
      })
    })

    it("attaches on the partitioned hydration path", async () => {
      const account = makeSyncedAccount()
      await remountWithSignaling()

      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(account),
      })

      await vi.waitFor(() =>
        expect(SignalingTransport).toHaveBeenCalledTimes(1),
      )
    })

    it("does not attach for a session disconnected mid-join", async () => {
      // Identify with nothing in storage yet, so the join below is the first
      // one and the transport is still unattached when it starts.
      await remountWithSignaling()
      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      seedConnectedAccount()
      expect(SignalingTransport).not.toHaveBeenCalled()

      // Every join path is fire-and-forget (`loadAuthData`,
      // `authenticateFromStorage`, `refreshStampFromStorage` — the last on
      // every accounts storage event), so a join is in flight inside
      // `deriveBusContext` for a few ticks after each auth event. A disconnect
      // landing in that window clears `removeBusSignalingTransport`
      // synchronously, and the join's continuation then attaches — and
      // re-registers — a transport for a session that no longer exists: an
      // open socket sitting in the signed-out account's room.
      ;(proxy as unknown as { joinAccountBus(): void }).joinAccountBus()
      await dispatch(
        { type: "disconnect", requestId: "r2" },
        PARENT_ORIGIN,
        parentWindow,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(SignalingTransport).not.toHaveBeenCalled()
    })

    it("does not attach for a session destroyed mid-join", async () => {
      await remountWithSignaling()
      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      seedConnectedAccount()
      expect(SignalingTransport).not.toHaveBeenCalled()

      // Same in-flight window as the disconnect case, on the unload path.
      // `destroy()` closes the bus; a continuation attaching after it would
      // open a socket into the account's room with no handle left to close it.
      ;(proxy as unknown as { joinAccountBus(): void }).joinAccountBus()
      proxy.destroy()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(SignalingTransport).not.toHaveBeenCalled()
    })

    it("does not attach without a configured signaling url", async () => {
      seedConnectedAccount()
      vi.mocked(SignalingTransport).mockClear()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )

      expect(SignalingTransport).not.toHaveBeenCalled()
    })
  })
})
