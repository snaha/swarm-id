// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-partitioning write enablement (docs/Account-Bus.md, phase 3): a
 * `setSecret` popup payload carrying the synced-account projection hydrates
 * the proxy into a first-class writer; the legacy secret-only payload stays
 * download-only.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest"

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
/** How long the mocked `yieldForPeer` takes — past rank 1's step (250 ms), as
 *  the real one (two stamped Swarm writes) always is. */
const SLOW_YIELD_MS = vi.hoisted(() => 400)

/** Devices the mocked `readRoster` reports for the account's Swarm roster. */
const rosterDevices = vi.hoisted(
  () => [] as { deviceId: string; createdAt: number; lastSignedInAt: number }[],
)
vi.mock("./sync", async (importActual) => {
  const actual = await importActual<typeof import("./sync")>()
  return { ...actual, readRoster: vi.fn(async () => rosterDevices) }
})
/** Lets a test count derivations (they run on every accounts storage event)
 *  and make one fail, without faking what a topic is. */
const busContextController = vi.hoisted(() => ({ failNext: false }))
vi.mock("./bus/bus-context", async (importActual) => {
  const actual = await importActual<typeof import("./bus/bus-context")>()
  return {
    ...actual,
    deriveBusContext: vi.fn(async (derivationKey: string) => {
      if (busContextController.failNext) {
        busContextController.failNext = false
        throw new Error("bus context derivation failed")
      }
      return actual.deriveBusContext(derivationKey)
    }),
  }
})
vi.mock("./sync/batch-write-coordinator", () => ({
  BatchWriteCoordinator: vi.fn(function (deps: unknown) {
    return {
      deps,
      startLease: vi.fn(),
      teardown: vi.fn(),
      withWrite: vi.fn(),
      // Deliberately NOT instant. The real yield is two stamped Swarm writes
      // (`yieldIdleLease` → `release`), i.e. far longer than a rank step, so a
      // mock that resolves in a microtask exercises the one timing production
      // never has — and hides whether the election's cancel signal actually
      // arrives before the other ranks fire.
      yieldForPeer: vi.fn(
        async () =>
          await new Promise<number>((resolve) =>
            setTimeout(() => resolve(1), SLOW_YIELD_MS),
          ),
      ),
      notifySlotMaybeFree: vi.fn(),
      currentPartition: undefined as number | undefined,
      // The modulus for the yield rank order; a test sets `currentPartition`
      // to place this holder in it.
      partitionCount: 4,
      /** Whether this holder would presently yield — only such holders take a
       *  rank. Mutable: a test can make the holder mid-burst. */
      canYieldForPeer: true,
    }
  }),
}))

import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"

import { SwarmIdProxy } from "./swarm-id-proxy"
import type { ProxyConfig } from "./swarm-id-proxy"
import { SignalingTransport } from "./bus/signaling-transport"
import { busChannelName } from "./bus/account-bus"
import { BusMessageSchema } from "./bus/messages"
import { deriveBusContext } from "./bus/bus-context"
import { BatchWriteCoordinator } from "./sync/batch-write-coordinator"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import {
  serializeAccount,
  serializeSyncedAccount,
} from "./utils/storage-managers"
import { serializeAccountStateSnapshot } from "./utils/account-state-snapshot"
import { STORAGE_CHALLENGE_KEY, STORAGE_KEY_ACCOUNTS } from "./types"
import { DEFAULT_BEE_NODE_URL } from "./schemas"
import type {
  ConnectedApp,
  PostageStamp,
  SignedInAccount,
  SyncedAccount,
} from "./schemas"

const PARENT_ORIGIN = "https://dapp.example.com"
const ID_ORIGIN = "https://id.example.com"
const BATCH_ID_HEX = "cc".repeat(32)
/** A second account: same dApp connection, different bus room. */
const OTHER_DERIVATION_KEY = "99".repeat(32)
/** A delta on the lane the tests bind (`partition 0` of 2), so a proxy that
 *  receives it folds it in — i.e. it doubles as "did this channel reach it". */
const UTILIZATION_DELTA = {
  type: "utilization-updated",
  batchId: BATCH_ID_HEX,
  partition: 0,
  partitionCount: 2,
  buckets: [{ index: 7, value: 6 }],
}

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

  /**
   * The bus channel for the test account. The transport is scoped to the
   * account-derived topic, so a test that wants to speak on the proxy's bus
   * has to derive the same one — posting on a fixed origin-wide name reaches
   * nobody.
   */
  let accountChannelName: string

  const topicFor = async (derivationKey: string): Promise<string> =>
    (await deriveBusContext(derivationKey)).topic

  beforeAll(async () => {
    accountChannelName = busChannelName(
      await topicFor(makeSyncedAccount().derivationKey),
    )
  })

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

  /**
   * Both bus transports now hang off an async key derivation, so a message
   * posted straight after an auth event can beat the channel into existence.
   * Production tolerates that (see `ensureAccountBusTransports`); a test must
   * not race it. `busTopic` is latched exactly when the transports go live, so
   * it is the real post-condition rather than a promise that also resolves on
   * failure.
   */
  const awaitBusJoin = () =>
    vi.waitFor(() => expect(busTopicNow()).toBeDefined())

  const busTopicNow = () =>
    (proxy as unknown as { busTopic: string | undefined }).busTopic

  /** The join every accounts storage event runs. */
  const rejoinBus = () =>
    (proxy as unknown as { joinAccountBus(): void }).joinAccountBus()

  /** Let a posted BroadcastChannel message be delivered (or provably not).
   *  Waiting on the receiver would only ever prove the positive case. */
  const flushBus = () => new Promise((resolve) => setTimeout(resolve, 20))

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

  // A partitioned session keeps its device id in the iframe's OWN (partitioned)
  // storage, which nothing outside the iframe can read. Whether that storage
  // survives a reload is the open question about real Safari (#584) — and if it
  // does not, every session is a new device in the roster (#570). Surfacing the
  // id is what lets a page answer that by comparing across loads.
  it("reports the proxy's device id in the connection info", async () => {
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(makeSyncedAccount()),
    })

    const storedId = localStorageFake.getItem("swarm-id-device-id")
    expect(storedId).toBeTruthy()

    const infos = messagesOfType("connectionInfoChanged")
    const reported = infos.map((info) => info.deviceId).filter(Boolean)
    expect(reported).not.toHaveLength(0)
    for (const id of reported) expect(id).toBe(storedId)
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
    await awaitBusJoin()
    const busChannel = new BroadcastChannel(accountChannelName)
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

  // A waiter needs exactly ONE slot, but the request names no partition. Every
  // idle holder used to answer, so a 4-partition account dropped all four
  // leases at once and whoever lost the re-race got "Uploads are unavailable".
  // The request id gives every holder the same rank order; only rank 0 answers
  // at once, and the rest stand down when they see it claim the request.
  describe("only one holder answers a lease-request", () => {
    /** Seed 0, so rank == the holder's own partition index. */
    const REQUEST_ID = "00000000"
    const ACCOUNT_ID = "aa".repeat(20)
    /** Past rank 1's step, but well inside the mocked yield. */
    const PAST_RANK_1_MS = 300

    type MockCoordinator = {
      yieldForPeer: ReturnType<typeof vi.fn>
      currentPartition: number | undefined
      partitionCount: number
      canYieldForPeer: boolean
    }

    async function hydrateHolder(partition: number): Promise<MockCoordinator> {
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(makeSyncedAccount()),
      })
      const coordinator = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
        .value as MockCoordinator
      coordinator.currentPartition = partition
      coordinator.partitionCount = 4
      coordinator.canYieldForPeer = true
      coordinator.yieldForPeer.mockClear()
      // The transports attach a few ticks after the auth event (the topic is
      // derived), so a test that posts straight after `sendSetSecret` would
      // race the channel into existence — and a negative assertion would pass
      // for the wrong reason.
      await awaitBusJoin()
      return coordinator
    }

    function postRequest(channel: BroadcastChannel, requestId?: string): void {
      channel.postMessage({
        type: "lease-request",
        accountId: ACCOUNT_ID,
        fromDeviceId: "peer-device",
        requestId,
      })
    }

    /** Everything this proxy publishes on the bus, in order. */
    function recordPublished(channel: BroadcastChannel): { type: string }[] {
      const seen: { type: string }[] = []
      channel.addEventListener("message", (event) => {
        seen.push((event as MessageEvent).data as { type: string })
      })
      return seen
    }

    it("answers immediately at rank 0", async () => {
      const coordinator = await hydrateHolder(0)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        postRequest(busChannel, REQUEST_ID)
        // No step waited: the ordinary one-holder handover must not get slower.
        await vi.waitFor(() =>
          expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1),
        )
      } finally {
        busChannel.close()
      }
    })

    // The signal the other ranks stand down on must precede the release, not
    // follow it: releasing is two stamped Swarm writes, so a signal sent after
    // it arrives long after every later rank has started releasing too.
    it("claims the request before its yield completes", async () => {
      await hydrateHolder(0)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        const published = recordPublished(busChannel)
        postRequest(busChannel, REQUEST_ID)
        await vi.waitFor(() =>
          expect(published).toContainEqual({
            type: "lease-claim",
            accountId: ACCOUNT_ID,
            fromDeviceId: expect.any(String),
            requestId: REQUEST_ID,
          }),
        )
        // Still mid-yield: no release announced yet.
        expect(published.some((m) => m.type === "lease-released")).toBe(false)
      } finally {
        busChannel.close()
      }
    })

    it("waits its step at a later rank, then answers if nobody else did", async () => {
      const coordinator = await hydrateHolder(1)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        postRequest(busChannel, REQUEST_ID)
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(coordinator.yieldForPeer).not.toHaveBeenCalled()

        // Rank 0 stayed silent (mid-write, say), so this holder still answers
        // rather than costing the waiter a whole poll interval.
        await vi.waitFor(
          () => expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1),
          { timeout: 2000 },
        )
      } finally {
        busChannel.close()
      }
    })

    it("stands down when a peer claims the same request first", async () => {
      const coordinator = await hydrateHolder(1)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        postRequest(busChannel, REQUEST_ID)
        busChannel.postMessage({
          type: "lease-claim",
          accountId: ACCOUNT_ID,
          fromDeviceId: "peer-device",
          requestId: REQUEST_ID,
        })
        // Well past this holder's step — and past the winner's whole yield.
        await new Promise((resolve) => setTimeout(resolve, SLOW_YIELD_MS + 200))
        expect(coordinator.yieldForPeer).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    it("stands down when a peer answers the same request first", async () => {
      const coordinator = await hydrateHolder(1)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        postRequest(busChannel, REQUEST_ID)
        busChannel.postMessage({
          type: "lease-released",
          accountId: ACCOUNT_ID,
          partition: 0,
          fromDeviceId: "peer-device",
          requestId: REQUEST_ID,
        })
        // Well past this holder's step.
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(coordinator.yieldForPeer).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    // The rank timer only STARTS the answer; the yield's first Swarm write is
    // still ahead of it. A claim landing in that window must still call it off,
    // which needs a memory of answered ids — the timer handle is already gone.
    it("stands down on a claim that arrives after its rank timer fired", async () => {
      const coordinator = await hydrateHolder(1)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        postRequest(busChannel, REQUEST_ID)
        await new Promise((resolve) => setTimeout(resolve, PAST_RANK_1_MS))
        busChannel.postMessage({
          type: "lease-claim",
          accountId: ACCOUNT_ID,
          fromDeviceId: "peer-device",
          requestId: REQUEST_ID,
        })
        // Same round, re-delivered (every transport, every re-broadcast): the
        // claim we just saw must keep this holder out of it. Waited out past a
        // full rank step, which is when a re-scheduled answer would fire.
        postRequest(busChannel, REQUEST_ID)
        await new Promise((resolve) => setTimeout(resolve, SLOW_YIELD_MS))
        expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1)
      } finally {
        busChannel.close()
      }
    })

    // A holder mid-burst declines in silence, so letting it hold a rank just
    // delays every holder behind it. With a 3 s idle threshold that is the
    // common case on an active account.
    it("takes no rank while it would decline anyway", async () => {
      const coordinator = await hydrateHolder(0)
      coordinator.canYieldForPeer = false
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        const published = recordPublished(busChannel)
        postRequest(busChannel, REQUEST_ID)
        await new Promise((resolve) => setTimeout(resolve, PAST_RANK_1_MS))
        expect(coordinator.yieldForPeer).not.toHaveBeenCalled()
        expect(published.some((m) => m.type === "lease-claim")).toBe(false)
      } finally {
        busChannel.close()
      }
    })

    // The rank is `parseInt(requestId, 16)`. A nanoid parses to NaN and a
    // leading minus parses negative — both used to put every holder at rank 0,
    // i.e. #576 again, silently. The schema drops them instead.
    it.each(["not-hex!", "-0000002", "00000000000000"])(
      "ignores a request whose id is %s",
      async (requestId) => {
        const coordinator = await hydrateHolder(0)
        const busChannel = new BroadcastChannel(accountChannelName)
        try {
          postRequest(busChannel, requestId)
          await new Promise((resolve) => setTimeout(resolve, PAST_RANK_1_MS))
          expect(coordinator.yieldForPeer).not.toHaveBeenCalled()
        } finally {
          busChannel.close()
        }
      },
    )

    it("schedules one answer however many times the request is delivered", async () => {
      const coordinator = await hydrateHolder(1)
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        // The same message reaches us over every attached transport, and the
        // waiter re-broadcasts each round.
        postRequest(busChannel, REQUEST_ID)
        postRequest(busChannel, REQUEST_ID)
        postRequest(busChannel, REQUEST_ID)
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1)
      } finally {
        busChannel.close()
      }
    })
  })

  it("announces the released partition when a teardown drops a held lease", async () => {
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, { account: serializeSyncedAccount(account) })

    const coordinator = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as { currentPartition: number | undefined }
    coordinator.currentPartition = 2

    await awaitBusJoin()
    const busChannel = new BroadcastChannel(accountChannelName)
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
    await awaitBusJoin()
    const busChannel = new BroadcastChannel(accountChannelName)
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

  // A revoke reaches a live proxy only through the browser `storage` event, and
  // `handleAccountStorageChange` skips the disconnect while partitioned — the
  // iframe cannot see connected apps. So on Safari a revoked session kept its
  // hydrated account view, stamp signer keys included, for the life of the
  // page. `account-delta` is the push channel that closes that.
  describe("account-delta from a peer", () => {
    /** The wire form: what a publisher puts on the bus. */
    function accountDelta(overrides?: {
      accountId?: string
      connectedApps?: ConnectedApp[]
      postageStamps?: PostageStamp[]
    }): Record<string, unknown> {
      const account = makeSyncedAccount()
      return {
        type: "account-delta",
        snapshot: serializeAccountStateSnapshot({
          accountId: overrides?.accountId ?? account.id.toHex(),
          metadata: {
            accountName: account.name,
            defaultPostageStampBatchID: BATCH_ID_HEX,
            publicKey: account.publicKey,
            settings: undefined,
            createdAt: account.createdAt,
            lastModified: Date.now(),
            devices: [],
            partitionCount: 2,
          },
          connectedApps: overrides?.connectedApps ?? [],
          postageStamps: overrides?.postageStamps ?? account.postageStamps,
          timestamp: Date.now(),
        }),
      }
    }

    /** A revoke as the UI writes it: auth material cleared, tombstoned. */
    function revoked(appUrl: string): ConnectedApp {
      const now = Date.now()
      return {
        appUrl,
        appName: "dApp",
        lastConnectedAt: now - 1000,
        appSecret: undefined,
        connectedUntil: undefined,
        updatedAt: now,
        revokedAt: now,
      }
    }

    async function hydratedSession(): Promise<BroadcastChannel> {
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(makeSyncedAccount()),
      })
      await awaitBusJoin()
      return new BroadcastChannel(accountChannelName)
    }

    it("disconnects a partitioned session when the delta revokes this app", async () => {
      const busChannel = await hydratedSession()
      try {
        busChannel.postMessage(
          accountDelta({ connectedApps: [revoked(PARENT_ORIGIN)] }),
        )
        await vi.waitFor(() =>
          expect(messagesOfType("disconnectResponse")).toHaveLength(1),
        )
        const infos = messagesOfType("connectionInfoChanged")
        expect(infos[infos.length - 1].canUpload).toBe(false)
      } finally {
        busChannel.close()
      }
    })

    // The wire form carries no `appSecret`/`connectedUntil` — they are
    // per-context session material, stripped at publish. A merged entry that
    // wins on recency would otherwise take this session's own auth with it,
    // and every unrelated account change would log the dApp out.
    it("keeps this session's own secret when the delta revokes another app", async () => {
      const busChannel = await hydratedSession()
      try {
        busChannel.postMessage(
          accountDelta({
            connectedApps: [
              revoked("https://other-dapp.example.com"),
              // Our app, as a publisher would send it: no secret, no session.
              {
                appUrl: PARENT_ORIGIN,
                appName: "dApp",
                lastConnectedAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          }),
        )
        await flushBus()
        expect(messagesOfType("disconnectResponse")).toHaveLength(0)

        // Still a writer: the session kept the secret the handshake gave it.
        const infos = messagesOfType("connectionInfoChanged")
        expect(infos[infos.length - 1].canUpload).toBe(true)
      } finally {
        busChannel.close()
      }
    })

    // The other half: a context that CAN see the change relays it. Nothing on
    // the wire may carry `appSecret` — the receiver may be an iframe embedded
    // by a different dApp, which the popup handshake never hands one to.
    it("publishes a delta on an account change, without any app secret", async () => {
      const busChannel = await hydratedSession()
      const published: Record<string, unknown>[] = []
      busChannel.onmessage = (event) =>
        published.push(event.data as Record<string, unknown>)
      try {
        await (
          proxy as unknown as {
            handleAccountStorageChange(): Promise<void>
          }
        ).handleAccountStorageChange()

        await vi.waitFor(
          () =>
            expect(
              published.filter((m) => m.type === "account-delta"),
            ).toHaveLength(1),
          { timeout: 3000 },
        )
        const snapshot = published.find((m) => m.type === "account-delta")!
          .snapshot as { connectedApps: Record<string, unknown>[] }
        expect(snapshot.connectedApps.length).toBeGreaterThan(0)
        for (const app of snapshot.connectedApps) {
          expect(app.appSecret).toBeUndefined()
          expect(app.connectedUntil).toBeUndefined()
        }
      } finally {
        busChannel.close()
      }
    })

    // The wire form carries no session material — but "the only publisher today
    // strips it" is an invariant one forgetful publisher away from breaking,
    // and part 3 is about to write the second one. A leaked entry for THIS app
    // (live `connectedUntil`, different secret) drives the reconcile into
    // `authenticateFromStorage`, which drops `partitionAccount` and clears
    // `storagePartitioned` — a Safari session bricked until reload.
    it("ignores session material a publisher failed to strip", async () => {
      const busChannel = await hydratedSession()
      const internals = proxy as unknown as {
        storagePartitioned: boolean
        partitionAccount: unknown
        appSecret: string | undefined
      }
      const secretBefore = internals.appSecret
      try {
        busChannel.postMessage(
          accountDelta({
            connectedApps: [
              {
                appUrl: PARENT_ORIGIN,
                appName: "dApp",
                lastConnectedAt: Date.now(),
                updatedAt: Date.now(),
                appSecret: "99".repeat(32),
                connectedUntil: Date.now() + 60_000,
              },
            ],
          }),
        )
        await flushBus()

        expect(internals.storagePartitioned).toBe(true)
        expect(internals.partitionAccount).toBeDefined()
        expect(internals.appSecret).toBe(secretBefore)
      } finally {
        busChannel.close()
      }
    })

    // Keeping signer keys on the wire is only worth anything if a receiver
    // acts on them: the fold updates the hydrated view, so the stamper has to
    // be rebuilt from it. `refreshStampFromStorage` is already proven safe
    // while partitioned — `hydratePartitionAccount` calls it.
    it("rebinds the stamper when a delta rotates the stamp's signer key", async () => {
      const busChannel = await hydratedSession()
      const rotated = "ee".repeat(32)
      try {
        const before = vi.mocked(UtilizationAwareStamper.create).mock.calls
          .length
        const stamp = makeSyncedAccount().postageStamps[0]
        busChannel.postMessage(
          accountDelta({
            postageStamps: [
              {
                ...stamp,
                signerKey: new PrivateKey(rotated),
                updatedAt: Date.now(),
              },
            ],
          }),
        )
        await vi.waitFor(() =>
          expect(
            vi.mocked(UtilizationAwareStamper.create).mock.calls.length,
          ).toBeGreaterThan(before),
        )
        const lastCall = vi
          .mocked(UtilizationAwareStamper.create)
          .mock.calls.at(-1)!
        expect(String(lastCall[0])).toBe(rotated)
      } finally {
        busChannel.close()
      }
    })

    // A `safeParse` failure is silent by design, so a serializer that drifts
    // from the schema would kill revoke propagation with no signal anywhere.
    it("publishes a wire form the receive schema accepts", async () => {
      const busChannel = await hydratedSession()
      const published: Record<string, unknown>[] = []
      busChannel.onmessage = (event) =>
        published.push(event.data as Record<string, unknown>)
      try {
        await (
          proxy as unknown as {
            handleAccountStorageChange(): Promise<void>
          }
        ).handleAccountStorageChange()
        await vi.waitFor(
          () =>
            expect(
              published.filter((m) => m.type === "account-delta"),
            ).toHaveLength(1),
          { timeout: 3000 },
        )

        const delta = published.find((m) => m.type === "account-delta")
        expect(() => BusMessageSchema.parse(delta)).not.toThrow()
      } finally {
        busChannel.close()
      }
    })

    // The feed publish re-arms when one is already in flight; the delta must
    // not ride along a second time.
    it("does not re-send the delta when a publish is already in flight", async () => {
      const busChannel = await hydratedSession()
      const published: Record<string, unknown>[] = []
      busChannel.onmessage = (event) =>
        published.push(event.data as Record<string, unknown>)
      const internals = proxy as unknown as {
        publishInFlight: boolean
        runAccountStatePublish(reason: "acquired" | "change"): Promise<void>
      }
      try {
        internals.publishInFlight = true
        await internals.runAccountStatePublish("change")
        await flushBus()
        expect(
          published.filter((m) => m.type === "account-delta"),
        ).toHaveLength(0)
      } finally {
        internals.publishInFlight = false
        busChannel.close()
      }
    })

    it("ignores a delta for a different account", async () => {
      const busChannel = await hydratedSession()
      try {
        busChannel.postMessage(
          accountDelta({
            accountId: "bb".repeat(20),
            connectedApps: [revoked(PARENT_ORIGIN)],
          }),
        )
        await flushBus()
        expect(messagesOfType("disconnectResponse")).toHaveLength(0)
      } finally {
        busChannel.close()
      }
    })
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
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
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
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
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
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
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
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
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
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
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

    /** Seed shared storage with an account already connected to the dApp.
     *  A different `derivationKey` makes it a different account — a different
     *  bus room — while staying connected to the same dApp, which is what an
     *  account switch looks like from in here. */
    function seedConnectedAccount(derivationKey?: string): SyncedAccount {
      const synced = { ...makeSyncedAccount() }
      if (derivationKey !== undefined) synced.derivationKey = derivationKey
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
      rejoinBus()
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
      rejoinBus()
      proxy.destroy()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(SignalingTransport).not.toHaveBeenCalled()
    })

    // The constructor connects synchronously, so a malformed url (or `ws://`
    // from an https page) throws right here. A failed attach must not count as
    // a completed join, or every later one dedups out against a transport that
    // never existed — signaling off for the session, with no retry.
    //
    // `function`, not an arrow: an arrow cannot be `new`'d, so the runtime
    // threw `TypeError: … is not a constructor` and the intended `SyntaxError`
    // body never ran. The test passed on the wrong throw.
    it("retries the signaling transport after its constructor throws", async () => {
      seedConnectedAccount()
      await remountWithSignaling()
      vi.mocked(SignalingTransport).mockImplementationOnce(function () {
        throw new SyntaxError("The URL's scheme must be 'ws' or 'wss'")
      })

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await vi.waitFor(() =>
        expect(SignalingTransport).toHaveBeenCalledTimes(1),
      )

      // A later join retries instead of dedup'ing against the failed attempt.
      rejoinBus()
      await vi.waitFor(() =>
        expect(SignalingTransport).toHaveBeenCalledTimes(2),
      )
    })

    // The local transport is account-scoped too, so it must attach whether or
    // not a bus server is configured — a build without one (GitHub Pages,
    // plain `pnpm dev`) still has same-device tabs to serve, and losing that
    // would silently stop cross-tab utilization from propagating.
    it("still joins the local bus without a configured signaling url", async () => {
      seedConnectedAccount()
      vi.mocked(SignalingTransport).mockClear()
      stamperStub.currentPartition = 0
      stamperStub.partitionCount = 2
      stamperStub.applyUtilizationUpdate.mockClear()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )

      expect(SignalingTransport).not.toHaveBeenCalled()

      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: [{ index: 7, value: 6 }],
        })
        await vi.waitFor(() =>
          expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
      } finally {
        busChannel.close()
      }
    })

    // The channel moved off the origin-wide name; anything still shouting on
    // it is talking to nobody.
    it("ignores traffic on the old origin-wide channel", async () => {
      seedConnectedAccount()
      stamperStub.currentPartition = 0
      stamperStub.partitionCount = 2
      stamperStub.applyUtilizationUpdate.mockClear()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )

      await awaitBusJoin()
      const legacy = new BroadcastChannel("swarm-id-bus-v1:origin")
      const scoped = new BroadcastChannel(accountChannelName)
      try {
        const delta = {
          type: "utilization-updated",
          batchId: BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: [{ index: 7, value: 6 }],
        }
        legacy.postMessage(delta)
        // Settle the legacy delivery on its own before the scoped one is even
        // sent: asserting on ordering across two channel names would be
        // asserting something the spec does not promise.
        await flushBus()
        expect(stamperStub.applyUtilizationUpdate).not.toHaveBeenCalled()

        scoped.postMessage(delta)
        await vi.waitFor(() =>
          expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
      } finally {
        legacy.close()
        scoped.close()
      }
    })

    // The signaling constructor throws synchronously on a url that is SET but
    // unusable (`ws://` from an https page, a CSP that omits the bus host, a
    // typo). That must cost the signaling transport only: taking the local one
    // down with it is the same "no bus at all, silently" this PR exists to
    // prevent, and it is indistinguishable from the healthy no-url case.
    it("keeps the local bus when the signaling constructor throws", async () => {
      seedConnectedAccount()
      await remountWithSignaling()
      vi.mocked(SignalingTransport).mockImplementation(function () {
        throw new SyntaxError("The URL's scheme must be 'ws' or 'wss'")
      } as never)
      stamperStub.currentPartition = 0
      stamperStub.partitionCount = 2
      stamperStub.applyUtilizationUpdate.mockClear()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await vi.waitFor(() => expect(SignalingTransport).toHaveBeenCalled())

      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage(UTILIZATION_DELTA)
        await vi.waitFor(() =>
          expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
      } finally {
        busChannel.close()
      }
    })

    // Switching accounts must LEAVE the old room, not just enter the new one:
    // the proxy is authenticated as B, and everything it publishes — once
    // `account-delta` rides the bus, that includes B's stamp signer keys —
    // would otherwise go to A's contexts as well.
    it("leaves the previous account's channel on a switch", async () => {
      seedConnectedAccount()
      stamperStub.currentPartition = 0
      stamperStub.partitionCount = 2
      stamperStub.applyUtilizationUpdate.mockClear()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await awaitBusJoin()
      const first = busTopicNow()

      const switched = seedConnectedAccount(OTHER_DERIVATION_KEY)
      rejoinBus()
      await vi.waitFor(() => expect(busTopicNow()).not.toBe(first))

      const previous = new BroadcastChannel(accountChannelName)
      const current = new BroadcastChannel(
        busChannelName(await topicFor(switched.derivationKey)),
      )
      try {
        previous.postMessage(UTILIZATION_DELTA)
        await flushBus()
        expect(stamperStub.applyUtilizationUpdate).not.toHaveBeenCalled()

        current.postMessage(UTILIZATION_DELTA)
        await vi.waitFor(() =>
          expect(stamperStub.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
      } finally {
        previous.close()
        current.close()
      }
    })

    // A switch that fails must fail SAFE. Keeping the old transports attached
    // leaves this session publishing B's traffic into A's room — the very leak
    // the account-scoped topic closes, surviving in the error path.
    it("drops the previous account's transports when a switch fails", async () => {
      seedConnectedAccount()
      stamperStub.currentPartition = 0
      stamperStub.partitionCount = 2
      stamperStub.applyUtilizationUpdate.mockClear()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await awaitBusJoin()

      seedConnectedAccount(OTHER_DERIVATION_KEY)
      busContextController.failNext = true
      rejoinBus()
      await vi.waitFor(() => expect(busTopicNow()).toBeUndefined())

      const previous = new BroadcastChannel(accountChannelName)
      try {
        previous.postMessage(UTILIZATION_DELTA)
        await flushBus()
        expect(stamperStub.applyUtilizationUpdate).not.toHaveBeenCalled()
      } finally {
        previous.close()
      }
    })

    // `new BroadcastChannel` throws `InvalidStateError` in a detaching
    // document. Whatever else fails, nothing may be left holding a live socket
    // with no handle to close it — the signaling transport connects in its
    // constructor and re-arms its own reconnect loop.
    it("opens no signaling socket when the local transport throws", async () => {
      seedConnectedAccount()
      await remountWithSignaling()
      const realBroadcastChannel = globalThis.BroadcastChannel
      vi.stubGlobal("BroadcastChannel", function () {
        throw new Error("InvalidStateError")
      } as never)
      try {
        await dispatch(
          {
            type: "parentIdentify",
            requestId: "r1",
            metadata: { name: "dApp" },
          },
          PARENT_ORIGIN,
          parentWindow,
        )
        await flushBus()
        expect(SignalingTransport).not.toHaveBeenCalled()
      } finally {
        vi.stubGlobal("BroadcastChannel", realBroadcastChannel)
      }
    })

    // `joinAccountBus` runs on every accounts storage event. Re-deriving there
    // costs two HMACs and an `importKey` per event, and bumps the join
    // generation, which cancels any join still in flight.
    it("does not re-derive the bus context for the same account", async () => {
      seedConnectedAccount()

      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await awaitBusJoin()
      const derivations = vi.mocked(deriveBusContext).mock.calls.length

      rejoinBus()
      rejoinBus()
      await flushBus()

      expect(vi.mocked(deriveBusContext).mock.calls.length).toBe(derivations)
    })
  })
})
