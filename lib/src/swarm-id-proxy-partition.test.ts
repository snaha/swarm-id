// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-partitioning write enablement (docs/Account-Bus.md, phase 3): a
 * `setSecret` popup payload carrying the synced-account projection hydrates
 * the proxy into a first-class writer; a payload without one is refused.
 */

import { derivePostageSignerKeySync } from "./utils/key-derivation"
import type { ActKeyCandidates } from "./proxy/act"
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

/** A stamp `Worker` that answers `init` and remembers the key it was handed. */
class FakeStampWorker {
  static instances: FakeStampWorker[] = []
  onmessage: ((event: MessageEvent) => void) | undefined
  onerror: ((event: ErrorEvent) => void) | undefined
  signerKeyHex: string | undefined
  terminated = false

  constructor() {
    FakeStampWorker.instances.push(this)
  }

  postMessage(message: { type: string; signerKeyHex?: string }): void {
    if (message.type !== "init") return
    this.signerKeyHex = message.signerKeyHex
    queueMicrotask(() =>
      this.onmessage?.({
        data: { type: "ready", issuerHex: "00".repeat(20) },
      } as MessageEvent),
    )
  }

  terminate(): void {
    this.terminated = true
  }
}

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
/**
 * The background verify a restored session runs (#635). Left answering
 * `undefined` — "nothing published" — so the tests that do not care about it
 * are not steered by it; the one that does sets a folded account.
 */
const foldedFromSwarm = vi.hoisted(
  () => ({ value: undefined }) as { value: unknown },
)
vi.mock("./sync/fold-account-from-swarm", async (importActual) => {
  const actual =
    await importActual<typeof import("./sync/fold-account-from-swarm")>()
  return {
    ...actual,
    foldAccountFromSwarm: vi.fn(() => Promise.resolve(foldedFromSwarm.value)),
  }
})

// `getDrives` describes each drive with live node and chain reads; none is
// reachable here, and the shape is what the test is after.
vi.mock("./utils/ttl", async (importActual) => ({
  ...(await importActual<typeof import("./utils/ttl")>()),
  fetchBatchDetails: vi.fn(async () => undefined),
  fetchSwarmPrice: vi.fn(async () => {
    throw new Error("offline")
  }),
}))
vi.mock("./utils/postage-contract", async (importActual) => ({
  ...(await importActual<typeof import("./utils/postage-contract")>()),
  fetchAuthoritativeBatchTTL: vi.fn(async () => 3600),
}))
vi.mock("./storage/utilization-store", () => ({
  UtilizationStoreDB: vi.fn(function () {
    return {}
  }),
}))
// The signaling transport opens a real WebSocket; the tests only assert that
// the proxy attaches one (and with which topic). The two handler lists let a
// test drive the room — an attributed delivery, and a departure — without one.
const signalingRoom = vi.hoisted(() => ({
  deliver: [] as ((raw: unknown, from?: string) => void)[],
  peerLeft: [] as ((peerId: string) => void)[],
}))
vi.mock("./bus/signaling-transport", () => ({
  SignalingTransport: vi.fn(function (options: unknown) {
    return {
      options,
      publish: vi.fn(),
      subscribe: vi.fn((handler: (raw: unknown, from?: string) => void) => {
        signalingRoom.deliver.push(handler)
        return () => {}
      }),
      onPeerLeft: vi.fn((handler: (peerId: string) => void) => {
        signalingRoom.peerLeft.push(handler)
        return () => {}
      }),
      close: vi.fn(),
    }
  }),
}))
/** How long the mocked `yieldForPeer` takes — past rank 1's step (250 ms), as
 *  the real one (two stamped Swarm writes) always is. */
const SLOW_YIELD_MS = vi.hoisted(() => 400)

/** Devices the mocked `readRoster` reports for the account's Swarm roster. */
// Typed as the real `Device` so a test row that drifts from the schema —
// a `name`, a `removedAt` — is a type error rather than a field Zod quietly
// drops on the way through.
const rosterDevices = vi.hoisted(() => [] as Device[])
vi.mock("./sync", async (importActual) => {
  const actual = await importActual<typeof import("./sync")>()
  return {
    ...actual,
    readRoster: vi.fn(async () => rosterDevices),
    publishDeviceState: vi.fn(async () => {}),
  }
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
/**
 * The grantee handlers, run against an ACT the identity published: the
 * sharing key (the second candidate) is the one the share names, so a denied
 * candidate fails the call with its own error, as the real module does
 * (`proxy/act/index.test.ts`, "fails with a denied candidate's error").
 */
vi.mock("./proxy/act", async (importActual) => {
  const actual = await importActual<typeof import("./proxy/act")>()
  const publishedByIdentity = (keys: ActKeyCandidates) => {
    const sharing = (Array.isArray(keys) ? keys : [keys])[1]
    if (sharing && !(sharing instanceof Uint8Array)) throw sharing.denied
  }
  return {
    ...actual,
    addGranteesToAct: vi.fn(async (_t, _b, _h, keys: ActKeyCandidates) => {
      publishedByIdentity(keys)
      return {
        historyReference: "h",
        granteeListReference: "g",
        actReference: "a",
      }
    }),
    revokeGranteesFromAct: vi.fn(
      async (_t, _b, _h, _e, keys: ActKeyCandidates) => {
        publishedByIdentity(keys)
        return {
          encryptedReference: "e",
          historyReference: "h",
          granteeListReference: "g",
          actReference: "a",
        }
      },
    ),
    getGranteesFromAct: vi.fn(async (_b, _h, keys: ActKeyCandidates) => {
      publishedByIdentity(keys)
      return []
    }),
  }
})
vi.mock("./sync/batch-write-coordinator", () => ({
  BatchWriteCoordinator: vi.fn(function (deps: {
    accountId: string
    batchId: string
    onLeaseReleased?: (partition: number, requestId?: string) => void
  }) {
    const coordinator = {
      deps,
      accountId: deps.accountId,
      batchId: deps.batchId,
      startLease: vi.fn(),
      // Like the real one: a held partition is announced on the way out.
      teardown: vi.fn(() => {
        if (coordinator.currentPartition !== undefined) {
          deps.onLeaseReleased?.(coordinator.currentPartition)
        }
      }),
      withWrite: vi.fn(),
      // Deliberately NOT instant. The real yield is two stamped Swarm writes
      // (`yieldIdleLease` → `release`), i.e. far longer than a rank step, so a
      // mock that resolves in a microtask exercises the one timing production
      // never has — and hides whether the election's cancel signal actually
      // arrives before the other ranks fire.
      yieldForPeer: vi.fn(
        async (requestId?: string) =>
          await new Promise<number>((resolve) =>
            setTimeout(() => {
              deps.onLeaseReleased?.(1, requestId)
              resolve(1)
            }, SLOW_YIELD_MS),
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
    return coordinator
  }),
}))

import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"

import { SwarmIdProxy, PUBLISH_DEBOUNCE_MS } from "./swarm-id-proxy"
import type { ProxyConfig } from "./swarm-id-proxy"
import { SignalingTransport } from "./bus/signaling-transport"
import { busChannelName } from "./bus/account-bus"
import { BusMessageSchema } from "./bus/messages"
import { deriveBusContext } from "./bus/bus-context"
import { BatchWriteCoordinator } from "./sync/batch-write-coordinator"
import { publishDeviceState, readRoster } from "./sync"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { DriveWritePath } from "./proxy/drive-write-path"
import {
  createAccountsStorageManager,
  serializeAccount,
  serializeSyncedAccount,
} from "./utils/storage-managers"
import { serializeAccountStateSnapshot } from "./utils/account-state-snapshot"
import {
  IframeToParentMessageSchema,
  storageChallengeKey,
  IDENTITY_SITE_STORAGE_KEY,
  STORAGE_KEY_ACCOUNTS,
  STORAGE_KEY_NETWORK_SETTINGS,
  leaseCacheStorageKey,
  partitionSessionStorageKey,
} from "./types"
import { KNOWN_DEVICE_MAX_AGE_MS } from "./utils/active-devices"
import { PRESENCE_INTERVAL_MS, PRESENCE_MAX_AGE_MS } from "./bus/presence"
import { mergeDevicesList } from "./sync/merge-snapshot"
import { foldAccountFromSwarm } from "./sync/fold-account-from-swarm"
import { DEFAULT_BEE_NODE_URL } from "./schemas"
import type {
  ConnectedApp,
  Device,
  PostageStamp,
  SignedInAccount,
  SyncedAccount,
} from "./schemas"

const PARENT_ORIGIN = "https://dapp.example.com"
/** A second dApp on the SAME SITE as `PARENT_ORIGIN`. The browser partitions
 *  the iframe's storage by (iframe origin, top-level SITE), so these two share
 *  one store — which is what makes them able to overwrite each other. */
const SIBLING_ORIGIN = "https://other.example.com"
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
  /**
   * Messages the proxy posted that the client would refuse to parse. The wire
   * is validated on ONE side only — `SwarmIdClient` parses what it receives,
   * `sendToParent` parses nothing it sends — so a shape only the proxy can
   * produce is dropped silently in the browser, and dropping the first
   * `connectionInfoChanged` leaves the dApp's `initialize()` to time out. Every
   * scenario in this file puts messages on that wire; each one is parsed here,
   * so the drift fails a test rather than a deployment.
   */
  let unsendable: Array<{ message: unknown; error: unknown }>
  let messageListener: MessageListener
  let localStorageFake: Storage
  let proxy: SwarmIdProxy
  /** The raw `storage` listener the proxy adds for network settings (#515). */
  let storageListener: (event: StorageEvent) => void

  /** (Re)create the proxy under a fresh window mock; keeps `localStorageFake`. */
  function mountProxy(config?: ProxyConfig): void {
    const listeners: Record<string, unknown> = {}
    const mockWindow = {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      // Delivers to the listener registered above, so a storage manager
      // created in a test reaches the proxy's the way it does in a window.
      dispatchEvent: vi.fn((event: Event) => {
        ;(listeners[event.type] as ((e: Event) => void) | undefined)?.(event)
        return true
      }),
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
    storageListener = listeners["storage"] as (event: StorageEvent) => void
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

    unsendable = []
    parentWindow = {
      postMessage: vi.fn((message: unknown) => {
        // `proxyInitialized` is the one message outside the union by design: it
        // goes out on a wildcard origin before the parent has identified
        // itself, and the client answers it ahead of its own schema parse.
        if ((message as { type?: string })?.type === "proxyInitialized") return
        const parsed = IframeToParentMessageSchema.safeParse(message)
        if (!parsed.success) unsendable.push({ message, error: parsed.error })
      }),
    }
    localStorageFake = makeLocalStorage()
    mountProxy()
  })

  // Each proxy subscribes the shared BroadcastChannel bus; without a destroy a
  // previous test's proxy keeps answering this test's bus traffic.
  afterEach(() => {
    proxy.destroy()
    // Whatever the scenario above was about, it also put messages on the wire.
    expect(unsendable).toEqual([])
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

  /**
   * Seed shared storage with an account already connected to the dApp — the
   * UNPARTITIONED setup, where the iframe reads the account document itself.
   *
   * `account` overrides are spread over the base record, so passing an explicit
   * `undefined` (a stamp-less account) removes the field rather than keeping
   * the default. A different `derivationKey` makes it a different account — a
   * different bus room — while staying connected to the same dApp, which is
   * what an account switch looks like from in here.
   */
  function seedConnectedAccount(overrides?: {
    account?: Partial<SyncedAccount>
    connectedApps?: ConnectedApp[]
  }): SyncedAccount {
    const synced: SyncedAccount = {
      ...makeSyncedAccount(),
      ...overrides?.account,
    }
    const stored: SignedInAccount = {
      ...synced,
      connectedApps: overrides?.connectedApps ?? [
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

  /** The connect challenge the proxy last armed and handed the parent. */
  function armedChallenge(): string | undefined {
    const armed = parentWindow.postMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          message?.type === "proxyReady" || message?.type === "challengeArmed",
      )
      .at(-1)
    return armed?.type === "proxyReady"
      ? armed.connectChallenge
      : armed?.challenge
  }

  /** Run identify → return the partition challenge the popup echoes. */
  async function startPartitionedConnect(
    appOrigin: string = PARENT_ORIGIN,
  ): Promise<string> {
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      appOrigin,
      parentWindow,
    )
    const challenge = armedChallenge()
    expect(challenge).toBeTruthy()
    return challenge!
  }

  async function sendSetSecret(
    challenge: string,
    data: Record<string, unknown>,
    appOrigin: string = PARENT_ORIGIN,
  ): Promise<void> {
    await dispatch(
      {
        type: "setSecret",
        appOrigin,
        challenge,
        data: { secret: "33".repeat(32), ...data },
      },
      ID_ORIGIN,
    )
  }

  /** Reconnect the way a page load does: a new proxy over the same store. */
  async function reload(): Promise<void> {
    proxy.destroy()
    mountProxy()
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )
  }

  /** Connect with the handover the popup really sends: the account's own
   *  entry for this origin, whose `lastConnectedAt` is the instant being
   *  connected (`saveConnection` runs before `sendSecretToOpener`). */
  async function connectPartitionedAt(connectedAt: number): Promise<void> {
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount({
        ...makeSyncedAccount(),
        connectedApps: [
          {
            appUrl: PARENT_ORIGIN,
            appName: "dApp",
            lastConnectedAt: connectedAt,
          },
        ],
      }),
    })
  }

  // The parent opens the connect popup in the user's click — Firefox refuses
  // the iframe one (#751) — with a challenge armed ahead of it. Armed means
  // already in this frame's store when the parent learns it, so the popup's
  // partition check can never run ahead of the write.
  it("arms the connect challenge in its store before telling the parent it is ready", async () => {
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )

    const [ready] = messagesOfType("proxyReady")
    expect(ready.connectChallenge).toBeTruthy()
    expect(
      localStorageFake.getItem(storageChallengeKey(ready.connectChallenge)),
    ).not.toBeNull()
    expect(window.open).not.toHaveBeenCalled()
  })

  // Same-site dApps share this store, each with its own proxy armed ahead of
  // any click: one key per challenge, or the last proxy loaded would
  // overwrite the others' and their popups would misread the store.
  it("keeps each proxy's challenge under its own key in a shared store", async () => {
    const first = await startPartitionedConnect()
    const firstProxy = proxy
    mountProxy()
    try {
      const second = await startPartitionedConnect()

      expect(second).not.toBe(first)
      expect(
        localStorageFake.getItem(storageChallengeKey(first)),
      ).not.toBeNull()
      expect(
        localStorageFake.getItem(storageChallengeKey(second)),
      ).not.toBeNull()
    } finally {
      firstProxy.destroy()
    }
  })

  it("takes the handover on the armed challenge, then arms the next one", async () => {
    const challenge = await startPartitionedConnect()

    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(makeSyncedAccount()),
    })

    expect(messagesOfType("authSuccess")).toHaveLength(1)
    const next = armedChallenge()
    expect(next).toBeTruthy()
    expect(next).not.toBe(challenge)
    expect(localStorageFake.getItem(storageChallengeKey(challenge))).toBeNull()
    expect(localStorageFake.getItem(storageChallengeKey(next!))).not.toBeNull()
  })

  // The app fell back to this site because the one the user chose did not
  // come up (#849): the popup this proxy's own button opens warns about it,
  // as the one the app page opens does.
  it("puts the chosen site that failed on the popup its own button opens", async () => {
    await dispatch(
      {
        type: "parentIdentify",
        requestId: "r1",
        metadata: { name: "dApp" },
        failedIdentitySite: "https://other.example/id",
      },
      PARENT_ORIGIN,
      parentWindow,
    )
    ;(proxy as unknown as { openAuthPopup(): boolean }).openAuthPopup()

    const url = vi.mocked(window.open).mock.calls[0][0] as string
    expect(new URLSearchParams(url.split("#")[1]).get("failedSite")).toBe(
      "https://other.example/id",
    )
  })

  // The app page learns the challenge on `proxyReady` (#751), so the
  // challenge only says WHICH attempt a handover belongs to: what makes it a
  // handover is coming from the identity origin, which only the connect popup
  // can. A page that knows the challenge still cannot hand this frame a
  // session of its own making.
  it("refuses a handover the app page sends with the right challenge", async () => {
    const challenge = await startPartitionedConnect()

    await dispatch(
      {
        type: "setSecret",
        appOrigin: PARENT_ORIGIN,
        challenge,
        data: {
          secret: "33".repeat(32),
          account: serializeSyncedAccount(makeSyncedAccount()),
        },
      },
      PARENT_ORIGIN,
      parentWindow,
    )

    expect(messagesOfType("authSuccess")).toHaveLength(0)
  })

  // One handover per challenge: once taken, a replay of it — a second popup
  // of the same attempt, or anything that saw the URL — is not a session.
  it("refuses a second handover on a challenge already taken", async () => {
    const challenge = await startPartitionedConnect()
    const account = serializeSyncedAccount(makeSyncedAccount())
    await sendSetSecret(challenge, { account })
    expect(messagesOfType("authSuccess")).toHaveLength(1)

    await sendSetSecret(challenge, { account })

    expect(messagesOfType("authSuccess")).toHaveLength(1)
  })

  // The popup this proxy's own button opens asks it who the app is (#915):
  // the proxy vouches with the parent origin it verified, and only to a
  // window on its own origin.
  it("vouches for its parent's origin to a popup on its own origin", async () => {
    await startPartitionedConnect()
    const popup = { postMessage: vi.fn() }

    await dispatch({ type: "openerCheck", nonce: "n-1" }, ID_ORIGIN, popup)
    await dispatch(
      { type: "openerCheck", nonce: "n-2" },
      "https://evil.example",
      popup,
    )

    expect(popup.postMessage).toHaveBeenCalledTimes(1)
    expect(popup.postMessage).toHaveBeenCalledWith(
      {
        type: "openerCheckResponse",
        nonce: "n-1",
        parentOrigin: PARENT_ORIGIN,
      },
      ID_ORIGIN,
    )
  })

  it("removes its armed challenge from the store when destroyed", async () => {
    const challenge = await startPartitionedConnect()

    proxy.destroy()

    expect(localStorageFake.getItem(storageChallengeKey(challenge))).toBeNull()
  })

  // The lease cache is a HINT at which lane this device holds, and a lane is
  // one partition of one batch. Keyed per account alone, the two coordinators
  // an account has whenever a dApp carries a per-app stamp override share one
  // slot and overwrite each other. Safe — `hydrate` refuses a snapshot whose
  // `batchId` differs, so the loser cold-acquires — but a hint that stops
  // hinting exactly when there are two writers to hint for is no hint.
  // The popup says the user's account is on another identity site (#849):
  // this iframe's part is to tell the app, which re-embeds from there.
  it("relays the popup's identitySiteChosen to the parent, for this attempt only", async () => {
    const challenge = await startPartitionedConnect()

    await dispatch(
      {
        type: "identitySiteChosen",
        appOrigin: PARENT_ORIGIN,
        challenge: "not-this-attempt",
        site: "https://other.example/id",
      },
      ID_ORIGIN,
    )
    expect(messagesOfType("switchIdentitySite")).toEqual([])

    await dispatch(
      {
        type: "identitySiteChosen",
        appOrigin: PARENT_ORIGIN,
        challenge,
        site: "https://other.example/id",
      },
      ID_ORIGIN,
    )
    expect(messagesOfType("switchIdentitySite")).toEqual([
      { type: "switchIdentitySite", site: "https://other.example/id" },
    ])
    expect(localStorageFake.getItem(storageChallengeKey(challenge))).toBeNull()
  })

  // The choice made on this site's popup is this site's to report (#849):
  // in `proxyReady`, and gone again on the app's say-so.
  it("reports the remembered identity site on proxyReady and clears it on request", async () => {
    localStorageFake.setItem(
      IDENTITY_SITE_STORAGE_KEY,
      "https://other.example/id",
    )
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )
    expect(messagesOfType("proxyReady")[0]).toMatchObject({
      identitySite: "https://other.example/id",
    })

    await dispatch(
      { type: "clearIdentitySite", requestId: "r2" },
      PARENT_ORIGIN,
      parentWindow,
    )
    expect(localStorageFake.getItem(IDENTITY_SITE_STORAGE_KEY)).toBeNull()
    expect(messagesOfType("clearIdentitySiteResponse")).toEqual([
      { type: "clearIdentitySiteResponse", requestId: "r2" },
    ])
  })

  it("does not evict another batch's lease-cache entry", async () => {
    const accountId = "aa".repeat(20)
    const otherBatch = "dd".repeat(32)
    const otherKey = leaseCacheStorageKey(accountId, otherBatch)
    // What this account's OTHER coordinator has already cached.
    localStorageFake.setItem(
      otherKey,
      JSON.stringify({ deviceId: "other-device", batchId: otherBatch }),
    )

    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(makeSyncedAccount()),
    })
    const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as {
      deps: {
        writeLeaseCache: (snap: unknown) => void
        readLeaseCache: () => unknown
      }
    }

    deps.writeLeaseCache({ deviceId: "self-device", batchId: BATCH_ID_HEX })

    const other = JSON.parse(localStorageFake.getItem(otherKey)!) as {
      deviceId: string
    }
    expect(other.deviceId).toBe("other-device")
    // And ours does not read theirs back: a snapshot for another batch is not
    // a hint this coordinator can use, and `hydrate` would only drop it.
    expect(deps.readLeaseCache()).toMatchObject({ deviceId: "self-device" })
  })

  // A payload with no account used to build a "download-only" session: no
  // stamps, and — the part that made it untenable — no `derivationKey`, so it
  // derived no bus topic, joined no room, and could never be told it had been
  // revoked. `AuthDataSchema` now requires the projection, so the parse fails
  // and the message is ignored. No session beats a session nothing can reach.
  // The end has to be stated in the language the merge ranks on (#682 review).
  // This wrote `lastConnectedAt: 0` — a sentinel nothing read, and under the
  // membership clock the value that loses every merge, so the next fold handed
  // the entry its old timestamp back and a dApp-initiated Disconnect never
  // travelled the way the identity UI's does.
  it("states a dApp-initiated disconnect on the entry", async () => {
    seedConnectedAccount()
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )
    const before = Date.now()

    await dispatch(
      { type: "disconnect", requestId: "r2" },
      PARENT_ORIGIN,
      parentWindow,
    )

    const stored = JSON.parse(
      localStorageFake.getItem(STORAGE_KEY_ACCOUNTS)!,
    ) as { data: { connectedApps: Record<string, unknown>[] }[] }
    const app = stored.data[0].connectedApps.find(
      (entry) => entry.appUrl === PARENT_ORIGIN,
    )!
    expect(app.disconnectedAt).toBeGreaterThanOrEqual(before)
    expect(app.connectedUntil).toBeUndefined()
    expect(app.appSecret).toBeUndefined()
    // Not zeroed: the connection did happen, and a merge that ranks on
    // `max(revokedAt, disconnectedAt, lastConnectedAt)` needs the truth.
    expect(app.lastConnectedAt).toBeGreaterThan(0)
  })

  // `loadAuthData` runs in the identify handler, off the reconcile queue, so a
  // storage event's `refreshStampFromStorage` runs while `initializeStamper`
  // is inside an await. It used to read the batch id again afterwards: cleared
  // in between, the coordinator was built for `batchId: undefined` and every
  // lease op on it threw (#804).
  it("drops a stamper init whose stamp was cleared while it awaited", async () => {
    seedConnectedAccount()
    const coordinatorsBefore = vi.mocked(BatchWriteCoordinator).mock.results
      .length
    let finishCreate: (() => void) | undefined
    vi.mocked(UtilizationAwareStamper.create).mockImplementationOnce(
      (_signerKey, batchId) =>
        new Promise<UtilizationAwareStamper>((resolve) => {
          finishCreate = () =>
            resolve(
              Object.assign(stamperStub, {
                mock: "stamper",
                batchId,
              }) as unknown as UtilizationAwareStamper,
            )
        }),
    )
    const identified = dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )
    await vi.waitFor(() => expect(finishCreate).toBeDefined())

    // The drive goes away; the storage event's reconcile clears the stamp.
    const shell = createAccountsStorageManager()
    shell.save(
      shell.load().map((account) => ({
        ...account,
        postageStamps: [],
        defaultPostageStampBatchID: undefined,
      })),
    )
    await flushBus()

    finishCreate!()
    await identified

    const internals = proxy as unknown as { drive?: { stamper: unknown } }
    expect(internals.drive?.stamper).toBeUndefined()
    expect(vi.mocked(BatchWriteCoordinator).mock.results).toHaveLength(
      coordinatorsBefore,
    )
  })

  // The case a batch/key compare would miss: a re-resolve of the SAME stamp
  // whose stale init's create RESOLVES after the newer init built its
  // coordinator. Only identity tells the two inits apart. A stale init that
  // gets through builds a coordinator on an orphaned write path, which nothing
  // tears down: its lease and refresh timer run until the iframe goes away.
  it("drops a stale init of the same drive whose create resolves after the newer init", async () => {
    seedConnectedAccount()
    const coordinatorsBefore = vi.mocked(BatchWriteCoordinator).mock.results
      .length
    let finishCreate: (() => void) | undefined
    vi.mocked(UtilizationAwareStamper.create).mockImplementationOnce(
      (_signerKey, batchId) =>
        new Promise<UtilizationAwareStamper>((resolve) => {
          finishCreate = () =>
            resolve(
              Object.assign(stamperStub, {
                mock: "stamper",
                batchId,
              }) as unknown as UtilizationAwareStamper,
            )
        }),
    )
    const identified = dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )
    await vi.waitFor(() => expect(finishCreate).toBeDefined())

    // A storage event during the first init finds no fingerprint yet and
    // resolves the same stamp again; that init builds the coordinator.
    const shell = createAccountsStorageManager()
    shell.save(shell.load())
    await vi.waitFor(() =>
      expect(vi.mocked(BatchWriteCoordinator).mock.results).toHaveLength(
        coordinatorsBefore + 1,
      ),
    )

    finishCreate!()
    await identified

    expect(vi.mocked(BatchWriteCoordinator).mock.results).toHaveLength(
      coordinatorsBefore + 1,
    )
  })

  // The branch the guard above does not take: the stale init's create REJECTS
  // — a batch just removed is the likeliest reason — and its catch used to
  // clear the stamper the superseding refresh had installed, so the session
  // reported stamper-failed with a working drive (#805 review).
  it.each([
    { drive: "a replaced drive", batch: "dd".repeat(32) },
    // A storage event during the first init finds no stamper fingerprint yet
    // and inits the same drive again; the first init is the stale one.
    { drive: "the same drive", batch: BATCH_ID_HEX },
  ])(
    "keeps the superseding refresh's stamper for $drive when the stale init's create rejects",
    async ({ batch }) => {
      seedConnectedAccount()
      let rejectCreate: ((error: Error) => void) | undefined
      vi.mocked(UtilizationAwareStamper.create).mockImplementationOnce(
        () =>
          new Promise<UtilizationAwareStamper>((_resolve, reject) => {
            rejectCreate = reject
          }),
      )
      const identified = dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await vi.waitFor(() => expect(rejectCreate).toBeDefined())

      // The reconcile builds a stamper for the drive it finds.
      const replacement = new BatchId(batch)
      const shell = createAccountsStorageManager()
      shell.save(
        shell.load().map((account) => ({
          ...account,
          defaultPostageStampBatchID: replacement,
          postageStamps: (account as SyncedAccount).postageStamps.map(
            (stamp) => ({
              ...stamp,
              batchID: replacement,
            }),
          ),
        })),
      )
      const internals = proxy as unknown as {
        drive?: { stamper: { batchId?: BatchId } | undefined }
      }
      await vi.waitFor(() =>
        expect(String(internals.drive?.stamper?.batchId)).toBe(
          replacement.toHex(),
        ),
      )

      rejectCreate!(new Error("batch gone"))
      await identified

      expect(String(internals.drive?.stamper?.batchId)).toBe(
        replacement.toHex(),
      )
      const infos = messagesOfType("connectionInfoChanged")
      expect(infos[infos.length - 1].uploadUnavailableReason).toBeUndefined()
    },
  )

  // An account's drives share no write state (#862): each has its own stamper,
  // coordinator and worker pool, and what a coordinator was built with reaches
  // ITS drive, never whichever one the session resolves by the time it calls.
  describe("each drive has its own write path", () => {
    const SECOND_BATCH_ID_HEX = "dd".repeat(32)
    const UNGRANTED_BATCH_ID_HEX = "ee".repeat(32)
    const ACCOUNT_ID = "aa".repeat(20)

    type StamperFake = {
      batchId: unknown
      flush: ReturnType<typeof vi.fn>
      getBucketUpdatesForBroadcast: () => { index: number; value: number }[]
      applyUtilizationUpdate: ReturnType<typeof vi.fn>
      currentPartition: number | undefined
      partitionCount: number
    }

    type CoordinatorFake = {
      batchId: string
      teardown: ReturnType<typeof vi.fn>
      withWrite: ReturnType<typeof vi.fn>
      yieldForPeer: ReturnType<typeof vi.fn>
      notifySlotMaybeFree: ReturnType<typeof vi.fn>
      currentPartition: number | undefined
      deps: {
        flushStamperState(): Promise<void>
        getWorkerPool(count?: number): Promise<unknown>
        onLeaseAcquired(partition: number): void
        onLeaseChange(): void
      }
    }

    type DriveInternals = {
      ensureCanUpload(batchId?: string): void
      pendingLaneUpdates: Map<string, unknown>
      withModeAwareWriteLock<T>(
        targetOptions: undefined,
        operation: (target: unknown) => Promise<T>,
        batchId?: string,
      ): Promise<T>
    }

    const internals = () => proxy as unknown as DriveInternals

    // `coordinatorFor` reads every coordinator built, so only this test's.
    beforeEach(() => {
      vi.mocked(BatchWriteCoordinator).mockClear()
    })
    // A queued `nextStamper` a test did not consume would hand its stamper to
    // the next test's first drive. Back to the default `create`.
    afterEach(() => {
      vi.mocked(UtilizationAwareStamper.create).mockReset()
    })

    /** A stamper of its own for the next `create`, so two drives' flushes and
     *  deltas can be told apart. */
    const nextStamper = (): StamperFake => {
      const stamper: StamperFake = {
        batchId: undefined,
        flush: vi.fn(async () => {}),
        getBucketUpdatesForBroadcast: () => [{ index: 1, value: 2 }],
        applyUtilizationUpdate: vi.fn(),
        currentPartition: 0,
        partitionCount: 2,
      }
      vi.mocked(UtilizationAwareStamper.create).mockImplementationOnce(
        async (_signerKey, batchId) => {
          stamper.batchId = batchId
          return stamper as unknown as UtilizationAwareStamper
        },
      )
      return stamper
    }

    const coordinatorFor = (batchId: string): CoordinatorFake | undefined =>
      vi
        .mocked(BatchWriteCoordinator)
        .mock.results.map((result) => result.value as CoordinatorFake)
        .filter((coordinator) => coordinator.batchId === batchId)
        .at(-1)

    const stampOf = (batchHex: string): PostageStamp => ({
      ...makeSyncedAccount().postageStamps[0],
      batchID: new BatchId(batchHex),
      signerKey: new PrivateKey(
        batchHex === BATCH_ID_HEX ? "22".repeat(32) : "23".repeat(32),
      ),
    })

    /** Connect the dApp to an account with two drives, both granted. */
    const connectWithTwoDrives = async (
      postageStamps = [stampOf(BATCH_ID_HEX), stampOf(SECOND_BATCH_ID_HEX)],
    ): Promise<void> => {
      seedConnectedAccount({
        account: { postageStamps },
        connectedApps: [
          {
            appUrl: PARENT_ORIGIN,
            appName: "dApp",
            appSecret: "44".repeat(32),
            lastConnectedAt: Date.now(),
            connectedUntil: Date.now() + 60_000,
            drives: [
              new BatchId(BATCH_ID_HEX),
              new BatchId(SECOND_BATCH_ID_HEX),
            ],
          },
        ],
      })
      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
    }

    /** Rewrite the stored account, which reaches the proxy as a storage event. */
    const updateAccount = (
      update: (account: SignedInAccount) => SignedInAccount,
    ) => {
      const shell = createAccountsStorageManager()
      shell.save((shell.load() as SignedInAccount[]).map(update))
    }

    /** Move the dApp off the first drive: the second is all it has left. */
    const dropFirstDrive = () =>
      updateAccount((account) => ({
        ...account,
        defaultPostageStampBatchID: new BatchId(SECOND_BATCH_ID_HEX),
        postageStamps: [stampOf(SECOND_BATCH_ID_HEX)],
        connectedApps: account.connectedApps.map((app) => ({
          ...app,
          drives: [new BatchId(SECOND_BATCH_ID_HEX)],
          drivesAt: Date.now(),
        })),
      }))

    it("builds the primary drive's write path at connect, and no other", async () => {
      nextStamper()
      await connectWithTwoDrives()

      expect(coordinatorFor(BATCH_ID_HEX)).toBeDefined()
      expect(coordinatorFor(SECOND_BATCH_ID_HEX)).toBeUndefined()
    })

    it("builds another granted drive's write path on its first write", async () => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()

      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )

      const second = coordinatorFor(SECOND_BATCH_ID_HEX)!
      expect(second.withWrite).toHaveBeenCalledTimes(2)
      expect(coordinatorFor(BATCH_ID_HEX)!.withWrite).not.toHaveBeenCalled()
      expect(
        vi
          .mocked(BatchWriteCoordinator)
          .mock.results.filter(
            (result) =>
              (result.value as CoordinatorFake).batchId === SECOND_BATCH_ID_HEX,
          ),
      ).toHaveLength(1)
    })

    // Every write handler has to hand its drive on: one that drops `batchID`
    // fails silently, landing the write on the primary instead.
    const HEX_32 = "ab".repeat(32)
    const targeted = { batchID: SECOND_BATCH_ID_HEX }
    const bytes = () => new Uint8Array([1, 2, 3])
    it.each([
      { type: "uploadData", data: bytes(), options: targeted },
      { type: "uploadFile", data: bytes(), name: "a.txt", options: targeted },
      {
        type: "uploadFiles",
        files: [{ path: "a.txt", data: bytes() }],
        options: targeted,
      },
      { type: "uploadChunk", data: bytes(), options: targeted },
      {
        type: "gsocSend",
        signer: HEX_32,
        identifier: HEX_32,
        data: bytes(),
        options: targeted,
      },
      {
        type: "socUpload",
        identifier: HEX_32,
        data: bytes(),
        options: targeted,
      },
      {
        type: "socRawUpload",
        identifier: HEX_32,
        data: bytes(),
        options: targeted,
      },
      {
        type: "epochFeedUploadReference",
        topic: HEX_32,
        at: 1,
        reference: HEX_32,
        batchID: SECOND_BATCH_ID_HEX,
      },
      {
        type: "seqFeedUploadPayload",
        topic: HEX_32,
        data: bytes(),
        index: 0,
        options: targeted,
      },
      {
        type: "seqFeedUploadRawPayload",
        topic: HEX_32,
        data: bytes(),
        index: 0,
        options: targeted,
      },
      {
        type: "seqFeedUploadReference",
        topic: HEX_32,
        reference: HEX_32,
        index: 0,
        options: targeted,
      },
      { type: "actUploadData", data: bytes(), grantees: [], options: targeted },
      {
        type: "actAddGrantees",
        historyReference: HEX_32,
        grantees: [],
        batchID: SECOND_BATCH_ID_HEX,
      },
      {
        type: "actRevokeGrantees",
        historyReference: HEX_32,
        encryptedReference: HEX_32,
        revokeGrantees: [],
        batchID: SECOND_BATCH_ID_HEX,
      },
      { type: "createFeedManifest", topic: HEX_32, uploadOptions: targeted },
    ])("$type writes through the drive it names", async (message) => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()

      await dispatch(
        { ...message, requestId: `w-${message.type}` },
        PARENT_ORIGIN,
        parentWindow,
      )

      await vi.waitFor(() =>
        expect(
          coordinatorFor(SECOND_BATCH_ID_HEX)?.withWrite,
        ).toHaveBeenCalled(),
      )
      expect(coordinatorFor(BATCH_ID_HEX)!.withWrite).not.toHaveBeenCalled()
    })

    it("refuses a write to a drive the app was not granted", async () => {
      nextStamper()
      await connectWithTwoDrives()

      await expect(
        internals().withModeAwareWriteLock(
          undefined,
          async () => undefined,
          UNGRANTED_BATCH_ID_HEX,
        ),
      ).rejects.toMatchObject({ code: "drive-not-granted" })
      expect(coordinatorFor(UNGRANTED_BATCH_ID_HEX)).toBeUndefined()
    })

    // #885: the sharing switches. Enforced where the sharing key is used,
    // reported on the snapshot, and the key itself withheld while the app may
    // not read with it.
    describe("the sharing switches", () => {
      const connectWith = async (
        app: Partial<ConnectedApp>,
        settings?: SyncedAccount["settings"],
      ) => {
        nextStamper()
        seedConnectedAccount({
          account: { settings },
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              appSecret: "44".repeat(32),
              lastConnectedAt: Date.now(),
              connectedUntil: Date.now() + 60_000,
              ...app,
            },
          ],
        })
        await dispatch(
          {
            type: "parentIdentify",
            requestId: "r1",
            metadata: { name: "dApp" },
          },
          PARENT_ORIGIN,
          parentWindow,
        )
      }
      const lastInfo = () => messagesOfType("connectionInfoChanged").at(-1)!
      const getPermissions = async () => {
        await dispatch(
          { type: "getPermissions", requestId: "gp" },
          PARENT_ORIGIN,
          parentWindow,
        )
        return messagesOfType("getPermissionsResponse").at(-1)!.permissions
      }

      // Which switch gates which handler, against an ACT the identity
      // published (the mocked `./proxy/act`): managing grantees needs write
      // access, listing them only data sharing.
      it("refuse to add or revoke grantees without write access, and still list them", async () => {
        await connectWith({ writeAccess: false })
        // The write lock is a fake; this one runs the operation handed to it.
        await vi.waitFor(() =>
          expect(coordinatorFor(BATCH_ID_HEX)).toBeDefined(),
        )
        coordinatorFor(BATCH_ID_HEX)!.withWrite.mockImplementation(
          async (operation: (target: unknown) => Promise<unknown>) =>
            operation({}),
        )
        const history = "ab".repeat(32)
        const grantee = new PrivateKey("cd".repeat(32))
          .publicKey()
          .toCompressedHex()

        await dispatch(
          {
            type: "actAddGrantees",
            requestId: "add",
            historyReference: history,
            grantees: [grantee],
          },
          PARENT_ORIGIN,
          parentWindow,
        )
        await dispatch(
          {
            type: "actRevokeGrantees",
            requestId: "revoke",
            historyReference: history,
            encryptedReference: "ef".repeat(32),
            revokeGrantees: [grantee],
          },
          PARENT_ORIGIN,
          parentWindow,
        )
        await dispatch(
          {
            type: "actGetGrantees",
            requestId: "list",
            historyReference: history,
          },
          PARENT_ORIGIN,
          parentWindow,
        )

        await vi.waitFor(() => {
          for (const requestId of ["add", "revoke"]) {
            expect(messagesOfType("error")).toContainEqual(
              expect.objectContaining({
                requestId,
                code: "permission-denied",
                permission: "writeAccess",
              }),
            )
          }
          expect(messagesOfType("actGetGranteesResponse")).toContainEqual(
            expect.objectContaining({ requestId: "list", grantees: [] }),
          )
        })
      })

      it("refuse to list grantees without data sharing", async () => {
        await connectWith({ dataSharing: false })

        await dispatch(
          {
            type: "actGetGrantees",
            requestId: "list",
            historyReference: "ab".repeat(32),
          },
          PARENT_ORIGIN,
          parentWindow,
        )

        await vi.waitFor(() =>
          expect(messagesOfType("error")).toContainEqual(
            expect.objectContaining({
              requestId: "list",
              code: "permission-denied",
              permission: "dataSharing",
            }),
          ),
        )
      })

      it("are on by default, and the snapshot carries the sharing key", async () => {
        await connectWith({})

        await expect(getPermissions()).resolves.toEqual({
          dataSharing: true,
          writeAccess: true,
        })
        expect(lastInfo().permissions).toEqual({
          dataSharing: true,
          writeAccess: true,
        })
        expect(lastInfo().identity.sharingPublicKey).toMatch(/^0[23]/)
      })

      it("follow the account defaults, and a pinned app value wins", async () => {
        await connectWith({ writeAccess: true }, { writeAccess: false })
        await expect(getPermissions()).resolves.toEqual({
          dataSharing: true,
          writeAccess: true,
        })
      })

      it("withhold the sharing key while data sharing is off", async () => {
        await connectWith({}, { dataSharing: false })

        expect(lastInfo().permissions).toEqual({
          dataSharing: false,
          writeAccess: false,
        })
        expect(lastInfo().identity.sharingPublicKey).toBeUndefined()
      })

      it("refuse to publish as the identity without write access", async () => {
        await connectWith({ writeAccess: false })

        await dispatch(
          {
            type: "actUploadData",
            requestId: "a1",
            data: new Uint8Array([1]),
            grantees: [],
            options: { publisher: "identity" },
          },
          PARENT_ORIGIN,
          parentWindow,
        )

        await vi.waitFor(() =>
          expect(messagesOfType("error")).toContainEqual(
            expect.objectContaining({
              requestId: "a1",
              code: "permission-denied",
              permission: "writeAccess",
            }),
          ),
        )
      })

      it("take effect when the user flips a switch, as a storage event", async () => {
        await connectWith({})

        updateAccount((account) => ({
          ...account,
          settings: { dataSharing: false },
          settingsAt: Date.now(),
        }))

        await vi.waitFor(() =>
          expect(lastInfo().permissions).toEqual({
            dataSharing: false,
            writeAccess: false,
          }),
        )
        await expect(getPermissions()).resolves.toEqual({
          dataSharing: false,
          writeAccess: false,
        })
      })
    })

    it("answers a write naming an ungranted drive with drive-not-granted", async () => {
      nextStamper()
      await connectWithTwoDrives()

      await dispatch(
        {
          type: "uploadData",
          requestId: "w1",
          data: new Uint8Array([1]),
          options: { batchID: UNGRANTED_BATCH_ID_HEX },
        },
        PARENT_ORIGIN,
        parentWindow,
      )

      await vi.waitFor(() =>
        expect(messagesOfType("error")).toContainEqual(
          expect.objectContaining({
            requestId: "w1",
            code: "drive-not-granted",
          }),
        ),
      )
    })

    // The grant is keyed by bare lowercase hex; a dApp may well pass the id
    // back `0x`-prefixed or uppercase, and that must not read as "not granted".
    it("writes through a granted drive spelled with 0x and uppercase", async () => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()

      await dispatch(
        {
          type: "uploadData",
          requestId: "w2",
          data: new Uint8Array([1]),
          options: { batchID: `0x${SECOND_BATCH_ID_HEX.toUpperCase()}` },
        },
        PARENT_ORIGIN,
        parentWindow,
      )

      await vi.waitFor(() =>
        expect(
          coordinatorFor(SECOND_BATCH_ID_HEX)!.withWrite,
        ).toHaveBeenCalledTimes(1),
      )
    })

    it("builds a scratch drive's stamper as a ring (#862)", async () => {
      nextStamper()
      await connectWithTwoDrives([
        stampOf(BATCH_ID_HEX),
        { ...stampOf(SECOND_BATCH_ID_HEX), kind: "scratch" },
      ])
      nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )

      const options = vi
        .mocked(UtilizationAwareStamper.create)
        .mock.calls.map((call) => ({
          batchId: (call[1] as BatchId).toHex(),
          scratch: call[7]?.scratch === true,
        }))
      expect(options).toEqual([
        { batchId: BATCH_ID_HEX, scratch: false },
        { batchId: SECOND_BATCH_ID_HEX, scratch: true },
      ])
    })

    it("lists the granted drives with the primary marked and each one's kind", async () => {
      nextStamper()
      await connectWithTwoDrives([
        stampOf(BATCH_ID_HEX),
        { ...stampOf(SECOND_BATCH_ID_HEX), kind: "scratch" },
      ])

      await dispatch(
        { type: "getDrives", requestId: "g1" },
        PARENT_ORIGIN,
        parentWindow,
      )

      await vi.waitFor(() =>
        expect(messagesOfType("getDrivesResponse")).toHaveLength(1),
      )
      const [response] = messagesOfType("getDrivesResponse")
      expect(
        (
          response.drives as {
            batchID: string
            kind: string
            primary: boolean
            batchTTL: number
          }[]
        ).map(({ batchID, kind, primary, batchTTL }) => ({
          batchID,
          kind,
          primary,
          batchTTL,
        })),
      ).toEqual([
        {
          batchID: BATCH_ID_HEX,
          kind: "regular",
          primary: true,
          batchTTL: 3600,
        },
        {
          batchID: SECOND_BATCH_ID_HEX,
          kind: "scratch",
          primary: false,
          batchTTL: 3600,
        },
      ])
    })

    // #882: each drive's lane is its own, and the dApp hears about every move.
    it("reports each drive's own lane, and announces a lane moving on a drive other than the primary", async () => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      const first = coordinatorFor(BATCH_ID_HEX)!
      const second = coordinatorFor(SECOND_BATCH_ID_HEX)!
      first.currentPartition = 0
      second.currentPartition = 1
      // Announce this baseline, so the emit below can only come from the
      // second drive's lane: the primary's partition no longer moves.
      second.deps.onLeaseChange()

      const lanes = async () => {
        const before = messagesOfType("getDrivesResponse").length
        await dispatch(
          { type: "getDrives", requestId: `lane-${before}` },
          PARENT_ORIGIN,
          parentWindow,
        )
        await vi.waitFor(() =>
          expect(messagesOfType("getDrivesResponse")).toHaveLength(before + 1),
        )
        const { drives } = messagesOfType("getDrivesResponse").at(-1)! as {
          drives: { batchID: string; partition?: number }[]
        }
        return drives.map(({ batchID, partition }) => ({ batchID, partition }))
      }
      expect(await lanes()).toEqual([
        { batchID: BATCH_ID_HEX, partition: 0 },
        { batchID: SECOND_BATCH_ID_HEX, partition: 1 },
      ])

      // The second drive's lease goes: nothing in the connection info moves
      // with it, and the dApp is told all the same, so it re-reads the drives.
      const announced = messagesOfType("connectionInfoChanged").length
      second.currentPartition = undefined
      second.deps.onLeaseChange()
      expect(messagesOfType("connectionInfoChanged")).toHaveLength(
        announced + 1,
      )
      expect(messagesOfType("connectionInfoChanged").at(-1)!.partition).toBe(0)
      expect(await lanes()).toEqual([
        { batchID: BATCH_ID_HEX, partition: 0 },
        { batchID: SECOND_BATCH_ID_HEX, partition: undefined },
      ])
      // And nothing moved: nothing is sent.
      second.deps.onLeaseChange()
      expect(messagesOfType("connectionInfoChanged")).toHaveLength(
        announced + 1,
      )
    })

    it("tears down only the drive that leaves the grant", async () => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      const first = coordinatorFor(BATCH_ID_HEX)!
      const second = coordinatorFor(SECOND_BATCH_ID_HEX)!

      updateAccount((account) => ({
        ...account,
        connectedApps: account.connectedApps.map((app) => ({
          ...app,
          drives: [new BatchId(BATCH_ID_HEX)],
          drivesAt: Date.now(),
        })),
      }))

      await vi.waitFor(() => expect(second.teardown).toHaveBeenCalled())
      expect(first.teardown).not.toHaveBeenCalled()
    })

    it("routes a lease-request to the drive it names", async () => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage({
          type: "lease-request",
          accountId: ACCOUNT_ID,
          batchId: SECOND_BATCH_ID_HEX,
          fromDeviceId: "peer-device",
          requestId: "00000000",
        })
        await vi.waitFor(() =>
          expect(
            coordinatorFor(SECOND_BATCH_ID_HEX)!.yieldForPeer,
          ).toHaveBeenCalledTimes(1),
        )
        expect(
          coordinatorFor(BATCH_ID_HEX)!.yieldForPeer,
        ).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    it("folds a utilization delta into the drive it names", async () => {
      const first = nextStamper()
      await connectWithTwoDrives()
      const second = nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage({
          type: "utilization-updated",
          batchId: SECOND_BATCH_ID_HEX,
          partition: 0,
          partitionCount: 2,
          buckets: [{ index: 3, value: 4 }],
        })
        await vi.waitFor(() =>
          expect(second.applyUtilizationUpdate).toHaveBeenCalledTimes(1),
        )
        expect(first.applyUtilizationUpdate).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    /** Both drives built, each holder at rank 1 for a request id of 0: its
     *  answer waits a rank step, long enough for a claim, a release or a
     *  teardown to reach it first. */
    const connectWithTwoHolders = async (): Promise<{
      first: CoordinatorFake
      second: CoordinatorFake
    }> => {
      nextStamper()
      await connectWithTwoDrives()
      nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      const first = coordinatorFor(BATCH_ID_HEX)!
      const second = coordinatorFor(SECOND_BATCH_ID_HEX)!
      first.currentPartition = 1
      second.currentPartition = 1
      await awaitBusJoin()
      return { first, second }
    }

    const requestLeaseOf = (
      channel: BroadcastChannel,
      batchId: string,
      requestId: string,
    ): void =>
      channel.postMessage({
        type: "lease-request",
        accountId: ACCOUNT_ID,
        batchId,
        fromDeviceId: "peer-device",
        requestId,
      })

    const laneUpdateFor = (channel: BroadcastChannel, batchId: string): void =>
      channel.postMessage({
        type: "utilization-updated",
        batchId,
        partition: 0,
        partitionCount: 2,
        buckets: [{ index: 3, value: 4 }],
      })

    /** Past rank 1's step, and past the mocked yield had it started. */
    const PAST_RANK_1_AND_YIELD_MS = 300 + SLOW_YIELD_MS

    it("routes a lease-claim to the drive it names", async () => {
      const { second } = await connectWithTwoHolders()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        requestLeaseOf(busChannel, SECOND_BATCH_ID_HEX, "00000000")
        busChannel.postMessage({
          type: "lease-claim",
          accountId: ACCOUNT_ID,
          batchId: SECOND_BATCH_ID_HEX,
          fromDeviceId: "peer-device",
          requestId: "00000000",
        })
        await new Promise((resolve) =>
          setTimeout(resolve, PAST_RANK_1_AND_YIELD_MS),
        )
        expect(second.yieldForPeer).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    it("routes a lease-released to the drive it names", async () => {
      const { first, second } = await connectWithTwoHolders()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage({
          type: "lease-released",
          accountId: ACCOUNT_ID,
          batchId: SECOND_BATCH_ID_HEX,
          partition: 0,
          fromDeviceId: "peer-device",
        })
        await vi.waitFor(() =>
          expect(second.notifySlotMaybeFree).toHaveBeenCalledTimes(1),
        )
        expect(first.notifySlotMaybeFree).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    it("cancels only the torn-down drive's scheduled answer", async () => {
      const { first, second } = await connectWithTwoHolders()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        requestLeaseOf(busChannel, BATCH_ID_HEX, "00000000")
        // Seed 1: rank 2, a step behind the first drive's answer.
        requestLeaseOf(busChannel, SECOND_BATCH_ID_HEX, "00000001")
        updateAccount((account) => ({
          ...account,
          connectedApps: account.connectedApps.map((app) => ({
            ...app,
            drives: [new BatchId(BATCH_ID_HEX)],
            drivesAt: Date.now(),
          })),
        }))
        await vi.waitFor(() => expect(second.teardown).toHaveBeenCalled())

        await vi.waitFor(() =>
          expect(first.yieldForPeer).toHaveBeenCalledTimes(1),
        )
        await new Promise((resolve) =>
          setTimeout(resolve, PAST_RANK_1_AND_YIELD_MS),
        )
        expect(second.yieldForPeer).not.toHaveBeenCalled()
      } finally {
        busChannel.close()
      }
    })

    it("keeps another drive's buffered lanes when one drive binds", async () => {
      const first = nextStamper()
      await connectWithTwoDrives()
      const second = nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      first.currentPartition = undefined
      second.currentPartition = undefined
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        laneUpdateFor(busChannel, BATCH_ID_HEX)
        laneUpdateFor(busChannel, SECOND_BATCH_ID_HEX)
        await flushBus()
        expect(second.applyUtilizationUpdate).not.toHaveBeenCalled()

        first.currentPartition = 0
        coordinatorFor(BATCH_ID_HEX)!.deps.onLeaseAcquired(0)
        second.currentPartition = 0
        coordinatorFor(SECOND_BATCH_ID_HEX)!.deps.onLeaseAcquired(0)

        expect(second.applyUtilizationUpdate).toHaveBeenCalledWith([
          { index: 3, value: 4 },
        ])
      } finally {
        busChannel.close()
      }
    })

    it("drops a torn-down drive's buffered lanes", async () => {
      nextStamper()
      await connectWithTwoDrives()
      const second = nextStamper()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      second.currentPartition = undefined
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      const bufferedForSecond = () =>
        [...internals().pendingLaneUpdates.keys()].filter((lane) =>
          lane.startsWith(`${SECOND_BATCH_ID_HEX}:`),
        )
      try {
        laneUpdateFor(busChannel, SECOND_BATCH_ID_HEX)
        await vi.waitFor(() => expect(bufferedForSecond()).toHaveLength(1))

        updateAccount((account) => ({
          ...account,
          connectedApps: account.connectedApps.map((app) => ({
            ...app,
            drives: [new BatchId(BATCH_ID_HEX)],
            drivesAt: Date.now(),
          })),
        }))
        await vi.waitFor(() =>
          expect(
            coordinatorFor(SECOND_BATCH_ID_HEX)!.teardown,
          ).toHaveBeenCalled(),
        )

        expect(bufferedForSecond()).toHaveLength(0)
      } finally {
        busChannel.close()
      }
    })

    it("refuses a write naming a drive on that drive, not on the primary", async () => {
      nextStamper()
      await connectWithTwoDrives([
        {
          ...stampOf(BATCH_ID_HEX),
          batchTTL: 60,
          updatedAt: Date.now() - 120_000,
        },
        stampOf(SECOND_BATCH_ID_HEX),
      ])
      nextStamper()

      expect(() => internals().ensureCanUpload()).toThrow(/expired/)
      expect(() =>
        internals().ensureCanUpload(SECOND_BATCH_ID_HEX),
      ).not.toThrow()
      await internals().withModeAwareWriteLock(
        undefined,
        async () => undefined,
        SECOND_BATCH_ID_HEX,
      )
      expect(
        coordinatorFor(SECOND_BATCH_ID_HEX)!.withWrite,
      ).toHaveBeenCalledTimes(1)
    })

    // Each runs from a coordinator torn down mid-write, and must reach the
    // drive it was built for.
    describe("a torn-down coordinator still reaches only its own drive", () => {
      it("flushes its own stamper, not the next drive's", async () => {
        nextStamper()
        await connectWithTwoDrives()
        const first = coordinatorFor(BATCH_ID_HEX)!
        const next = nextStamper()
        dropFirstDrive()
        await vi.waitFor(() =>
          expect(coordinatorFor(SECOND_BATCH_ID_HEX)).toBeDefined(),
        )

        await first.deps.flushStamperState()

        expect(next.flush).not.toHaveBeenCalled()
      })

      it("is handed no worker pool signing for the next drive", async () => {
        nextStamper()
        await connectWithTwoDrives()
        const first = coordinatorFor(BATCH_ID_HEX)!
        nextStamper()
        dropFirstDrive()
        await vi.waitFor(() =>
          expect(coordinatorFor(SECOND_BATCH_ID_HEX)).toBeDefined(),
        )
        const pools = vi.spyOn(
          DriveWritePath.prototype,
          "getOrCreateWorkerPool",
        )

        await first.deps.getWorkerPool(2)

        const askedOf = pools.mock.contexts.map(
          (drive) => (drive as DriveWritePath).batchId,
        )
        expect(askedOf).not.toContain(SECOND_BATCH_ID_HEX)
      })

      it("labels a utilization broadcast with its own batch when the drive changes mid-flush", async () => {
        const stamper = nextStamper()
        await connectWithTwoDrives()
        const first = coordinatorFor(BATCH_ID_HEX)!
        await awaitBusJoin()
        let finishFlush: (() => void) | undefined
        stamper.flush.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishFlush = resolve
            }),
        )
        const busChannel = new BroadcastChannel(accountChannelName)
        const published: { type: string; batchId?: string }[] = []
        busChannel.onmessage = (event) =>
          published.push(event.data as { type: string; batchId?: string })
        try {
          const flushed = first.deps.flushStamperState()
          await vi.waitFor(() => expect(finishFlush).toBeDefined())
          nextStamper()
          dropFirstDrive()
          await vi.waitFor(() =>
            expect(coordinatorFor(SECOND_BATCH_ID_HEX)).toBeDefined(),
          )

          finishFlush!()
          await flushed
          await flushBus()

          const labels = published
            .filter((message) => message.type === "utilization-updated")
            .map((message) => message.batchId)
          expect(labels).toEqual([BATCH_ID_HEX])
        } finally {
          busChannel.close()
        }
      })
    })
  })

  // The stamper and the coordinator that writes through it belong to one
  // stamp. Each case is a moment the two could disagree: an upload has to go
  // where the session says it goes, and never through a coordinator built for
  // a drive, or an account, the session has since moved off.
  describe("the write path follows the resolved stamp", () => {
    const GATEWAY_URL = "https://gateway.example.com/"
    const OTHER_BATCH_ID_HEX = "dd".repeat(32)
    const OTHER_ACCOUNT_ID_HEX = "bb".repeat(20)
    const OTHER_APP_SECRET = "55".repeat(32)
    const CONNECTION_LIFETIME_MS = 60_000

    type CoordinatorStub = {
      deps: { bee: { url: string } }
      batchId: string
      teardown: ReturnType<typeof vi.fn>
      withWrite: ReturnType<typeof vi.fn>
    }

    type WriteInternals = {
      bee: { url: string }
      ensureCanUpload(): void
      withModeAwareWriteLock<T>(
        targetOptions: undefined,
        operation: (target: unknown) => Promise<T>,
      ): Promise<T>
      buildConnectionInfo(): {
        uploadMode: string
        uploadUnavailableReason?: string
      }
    }

    const internals = () => proxy as unknown as WriteInternals

    /**
     * The target an upload is executed against, through the same two gates
     * every upload handler passes: the refusal check, then the mode-aware write.
     */
    const uploadTarget = async (): Promise<unknown> => {
      internals().ensureCanUpload()
      return internals().withModeAwareWriteLock(
        undefined,
        async (target) => target,
      )
    }

    /** Settle an upload either way, so what it reached is checked first. */
    const attemptUpload = () =>
      uploadTarget().then(
        (target) => ({ target }),
        (error: unknown) => ({ error }),
      )

    const coordinatorCount = () =>
      vi.mocked(BatchWriteCoordinator).mock.results.length

    const latestCoordinator = (): CoordinatorStub =>
      vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
        .value as CoordinatorStub

    const identify = (subsidisedGatewayUrl?: string) =>
      dispatch(
        {
          type: "parentIdentify",
          requestId: "r1",
          metadata: { name: "dApp" },
          subsidisedGatewayUrl,
        },
        PARENT_ORIGIN,
        parentWindow,
      )

    const lastConnectionInfo = () =>
      messagesOfType("connectionInfoChanged").at(-1)

    /**
     * Holds the next stamper `create`, which pauses that init before it has
     * assigned a stamper or a coordinator. `release` is set once the init
     * reaches it.
     */
    const holdNextCreate = () => {
      const held: { release?: () => void } = {}
      vi.mocked(UtilizationAwareStamper.create).mockImplementationOnce(
        (_signerKey, batchId) =>
          new Promise<UtilizationAwareStamper>((resolve) => {
            held.release = () =>
              resolve(
                Object.assign(stamperStub, {
                  mock: "stamper",
                  batchId,
                }) as unknown as UtilizationAwareStamper,
              )
          }),
      )
      return held
    }

    it("sends an upload to the gateway while the first stamper is being built", async () => {
      seedConnectedAccount()
      const coordinatorsBefore = coordinatorCount()
      const create = holdNextCreate()
      const identified = identify(GATEWAY_URL)
      await vi.waitFor(() => expect(create.release).toBeDefined())

      await expect(uploadTarget()).resolves.toEqual({
        mode: "subsidised",
        gatewayUrl: GATEWAY_URL,
      })
      expect(internals().buildConnectionInfo().uploadMode).toBe("subsidised")

      create.release!()
      await identified

      expect(coordinatorCount()).toBe(coordinatorsBefore + 1)
      const coordinator = latestCoordinator()
      expect(coordinator.batchId).toBe(BATCH_ID_HEX)
      expect(internals().buildConnectionInfo().uploadMode).toBe("user-stamp")
      await uploadTarget()
      expect(coordinator.withWrite).toHaveBeenCalledTimes(1)
    })

    it("drops the previous drive's coordinator before building the next one", async () => {
      seedConnectedAccount()
      await identify()
      const previous = latestCoordinator()

      const create = holdNextCreate()
      const replacement = new BatchId(OTHER_BATCH_ID_HEX)
      const shell = createAccountsStorageManager()
      shell.save(
        shell.load().map((account) => ({
          ...account,
          defaultPostageStampBatchID: replacement,
          postageStamps: (account as SyncedAccount).postageStamps.map(
            (stamp) => ({ ...stamp, batchID: replacement }),
          ),
        })),
      )
      await vi.waitFor(() => expect(create.release).toBeDefined())

      const outcome = await attemptUpload()
      expect(previous.withWrite).not.toHaveBeenCalled()
      expect(previous.teardown).toHaveBeenCalled()
      expect(outcome).toHaveProperty("error")

      create.release!()
      await vi.waitFor(() =>
        expect(latestCoordinator().batchId).toBe(OTHER_BATCH_ID_HEX),
      )
    })

    it("refuses an upload once the drive is removed instead of writing through its coordinator", async () => {
      seedConnectedAccount()
      await identify()
      const previous = latestCoordinator()

      const shell = createAccountsStorageManager()
      shell.save(
        shell.load().map((account) => ({
          ...account,
          postageStamps: [],
          defaultPostageStampBatchID: undefined,
        })),
      )
      await vi.waitFor(() =>
        expect(lastConnectionInfo()?.uploadUnavailableReason).toBe("no-stamp"),
      )

      const outcome = await attemptUpload()
      expect(previous.withWrite).not.toHaveBeenCalled()
      expect(previous.teardown).toHaveBeenCalled()
      expect(outcome).toHaveProperty("error")
      expect(internals().buildConnectionInfo()).toMatchObject({
        uploadMode: "unavailable",
        uploadUnavailableReason: "no-stamp",
      })
    })

    it("refuses an upload after the connection moves to an account with no drive", async () => {
      seedConnectedAccount()
      await identify()
      const previous = latestCoordinator()

      // The dApp is disconnected from the first account and connected to a
      // second, with a secret of its own — what the identity UI writes when the
      // user picks another account for it.
      const shell = createAccountsStorageManager()
      const [current] = shell.load() as SignedInAccount[]
      const now = Date.now()
      shell.save([
        {
          ...current,
          connectedApps: current.connectedApps.map((app) => ({
            ...app,
            appSecret: undefined,
            connectedUntil: undefined,
            disconnectedAt: now,
          })),
        },
        {
          ...current,
          id: new EthAddress(OTHER_ACCOUNT_ID_HEX),
          derivationKey: OTHER_DERIVATION_KEY,
          postageStamps: [],
          defaultPostageStampBatchID: undefined,
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              appSecret: OTHER_APP_SECRET,
              lastConnectedAt: now,
              connectedUntil: now + CONNECTION_LIFETIME_MS,
            },
          ],
        },
      ])
      await vi.waitFor(() =>
        expect(lastConnectionInfo()?.identity?.id).toBe(OTHER_ACCOUNT_ID_HEX),
      )

      const outcome = await attemptUpload()
      expect(previous.withWrite).not.toHaveBeenCalled()
      expect(previous.teardown).toHaveBeenCalled()
      expect(outcome).toHaveProperty("error")
      expect(internals().buildConnectionInfo()).toMatchObject({
        uploadMode: "unavailable",
        uploadUnavailableReason: "no-stamp",
      })
    })

    // Reads have to come from where the uploads go, or a dApp reads back a 404
    // for the chunk it just wrote; and a user-stamped write goes to the
    // configured node, never to the dApp's gateway.
    describe("the Bee client follows the upload mode", () => {
      // bee-js keeps a client's URL without its trailing slash.
      const CONFIGURED_NODE_URL = DEFAULT_BEE_NODE_URL.replace(/\/$/, "")
      const GATEWAY_NODE_URL = GATEWAY_URL.replace(/\/$/, "")
      const DRIVE_TTL_SECONDS = 60
      const PAST_DRIVE_TTL_MS = 61_000

      it("writes and reads at the configured node for a session connected after load", async () => {
        // Nothing connected yet: the session starts out subsidised.
        await identify(GATEWAY_URL)
        expect(internals().bee.url).toBe(GATEWAY_NODE_URL)
        const coordinatorsBefore = coordinatorCount()

        seedConnectedAccount()
        const shell = createAccountsStorageManager()
        shell.save(shell.load())
        await vi.waitFor(() =>
          expect(coordinatorCount()).toBe(coordinatorsBefore + 1),
        )

        expect(latestCoordinator().deps.bee.url).toBe(CONFIGURED_NODE_URL)
        expect(internals().bee.url).toBe(CONFIGURED_NODE_URL)
      })

      it("reads from the gateway once the drive's lifetime runs out in an open session", async () => {
        const [stamp] = makeSyncedAccount().postageStamps
        seedConnectedAccount({
          account: {
            postageStamps: [
              { ...stamp, batchTTL: DRIVE_TTL_SECONDS, updatedAt: Date.now() },
            ],
          },
        })
        await identify(GATEWAY_URL)
        expect(internals().buildConnectionInfo().uploadMode).toBe("user-stamp")
        expect(internals().bee.url).toBe(CONFIGURED_NODE_URL)

        vi.setSystemTime(Date.now() + PAST_DRIVE_TTL_MS)
        try {
          await expect(uploadTarget()).resolves.toEqual({
            mode: "subsidised",
            gatewayUrl: GATEWAY_URL,
          })
          expect(internals().bee.url).toBe(GATEWAY_NODE_URL)
        } finally {
          vi.useRealTimers()
        }
      })

      // A refused drive keeps its coordinator while the session reads as
      // subsidised. What that coordinator writes, the roster and this device's
      // state, it writes at the configured node, so it reads them back there.
      it("keeps the coordinator's roster reads at the configured node once the drive runs out", async () => {
        const [stamp] = makeSyncedAccount().postageStamps
        seedConnectedAccount({
          account: {
            postageStamps: [
              { ...stamp, batchTTL: DRIVE_TTL_SECONDS, updatedAt: Date.now() },
            ],
          },
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              appSecret: OTHER_APP_SECRET,
              lastConnectedAt: Date.now(),
              connectedUntil: Date.now() + PAST_DRIVE_TTL_MS * 2,
            },
          ],
        })
        await identify(GATEWAY_URL)
        const coordinator = latestCoordinator() as CoordinatorStub & {
          accountId?: string
          currentPartition?: number
          deps: {
            accountId: string
            refreshKnownDeviceIds: () => Promise<void>
          }
        }
        // A publish needs a held partition, and checks the snapshot's account
        // against the coordinator's, which the mock carries on `deps` only.
        coordinator.currentPartition = 0
        coordinator.accountId = coordinator.deps.accountId
        coordinator.withWrite.mockImplementationOnce(
          (write: (target: unknown) => Promise<void>) => write({}),
        )
        rosterDevices.length = 0
        vi.mocked(readRoster).mockClear()
        vi.mocked(publishDeviceState).mockClear()

        vi.setSystemTime(Date.now() + PAST_DRIVE_TTL_MS)
        try {
          expect(internals().bee.url).toBe(GATEWAY_NODE_URL)
          await coordinator.deps.refreshKnownDeviceIds()
          await (
            proxy as unknown as {
              runAccountStatePublish(reason: "acquired"): Promise<void>
            }
          ).runAccountStatePublish("acquired")
        } finally {
          vi.useRealTimers()
        }

        const rosterReads = vi
          .mocked(readRoster)
          .mock.calls.map(([options]) => options.bee.url)
        expect(rosterReads).toEqual([CONFIGURED_NODE_URL, CONFIGURED_NODE_URL])
        expect(vi.mocked(publishDeviceState)).toHaveBeenCalledOnce()
        expect(vi.mocked(publishDeviceState).mock.calls[0][0].bee.url).toBe(
          CONFIGURED_NODE_URL,
        )
      })
    })
  })

  it("refuses a handover that carries no account", async () => {
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {})

    expect(messagesOfType("authSuccess")).toHaveLength(0)
    const infos = messagesOfType("connectionInfoChanged")
    expect(infos[infos.length - 1]?.identity).toBeUndefined()
    expect(
      localStorageFake.getItem(partitionSessionStorageKey(PARENT_ORIGIN)),
    ).toBeNull()
  })

  // Refusing the payload is only half of it: the attempt it belongs to has to
  // end. The proxy's own auth button sets `isConnecting` and shows a spinner
  // until something clears it, and on this path nothing did — the spinner sat
  // there while the popup, which has no idea it was refused, said "Connected!"
  // (#587). The only thing that eventually cleared it was the popup closing,
  // which the user had no reason to do.
  it("ends the connect attempt when the handover cannot be parsed", async () => {
    const challenge = await startPartitionedConnect()
    const internals = proxy as unknown as {
      isConnecting: boolean
      pendingChallenge: string | undefined
    }
    // What `handleLoginClick` does when the button is the one connecting.
    internals.isConnecting = true

    await sendSetSecret(challenge, {})

    expect(internals.isConnecting).toBe(false)
    // The challenge stays: the popup is still open and may yet send a payload
    // this bundle can read. Refusing one message ends the attempt's spinner,
    // not the ceremony behind it.
    expect(internals.pendingChallenge).toBe(challenge)
  })

  // Two ways a partitioned session ends up unable to upload, and from the
  // dApp side they were indistinguishable — every one of them just said
  // "unavailable". That cost a real-Safari run (#584): an account with no drive
  // read as a failed `window.opener` handover, which is a claim about ITP.
  it("reports no-stamp when the handed-over account has no drive", async () => {
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount({
        ...account,
        defaultPostageStampBatchID: undefined,
        postageStamps: [],
      }),
    })

    const infos = messagesOfType("connectionInfoChanged")
    const last = infos[infos.length - 1]
    // The handover itself landed — that is what `storagePartitioned` means.
    expect(last.storagePartitioned).toBe(true)
    expect(last.uploadMode).toBe("unavailable")
    expect(last.uploadUnavailableReason).toBe("no-stamp")
  })

  it("reports stamper-failed when the stamp resolves but the stamper does not build", async () => {
    vi.mocked(UtilizationAwareStamper.create).mockRejectedValueOnce(
      new Error("IndexedDB unavailable"),
    )
    const account = makeSyncedAccount()
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(account),
    })

    const infos = messagesOfType("connectionInfoChanged")
    const last = infos[infos.length - 1]
    expect(last.storagePartitioned).toBe(true)
    expect(last.uploadMode).toBe("unavailable")
    expect(last.uploadUnavailableReason).toBe("stamper-failed")
  })

  // #745: an expired drive still resolves, and the stamper still builds from
  // its stored record, so nothing on that path said it could not stamp. The
  // first refused write then read as partition contention on a real phone.
  it("reports stamp-expired when the only drive's lifetime has run out", async () => {
    const account = makeSyncedAccount()
    const [stamp] = account.postageStamps
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount({
        ...account,
        postageStamps: [
          { ...stamp, batchTTL: 60, updatedAt: Date.now() - 120_000 },
        ],
      }),
    })

    const infos = messagesOfType("connectionInfoChanged")
    const last = infos[infos.length - 1]
    expect(last.storagePartitioned).toBe(true)
    expect(last.canUpload).toBe(false)
    expect(last.uploadMode).toBe("unavailable")
    expect(last.uploadUnavailableReason).toBe("stamp-expired")
  })

  // #765: `exists` and `usable` are on the stored record and were read
  // nowhere, so `canUpload` was true for a batch the node did not have or
  // could not use yet, and the refusal arrived 30 s later as a timeout.
  it.each([
    { field: "usable", record: { usable: false } },
    { field: "exists", record: { exists: false } },
  ])(
    "reports stamp-not-usable when the drive's record says $field is false",
    async ({ record }) => {
      const account = makeSyncedAccount()
      const [stamp] = account.postageStamps
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount({
          ...account,
          postageStamps: [{ ...stamp, ...record }],
        }),
      })

      const infos = messagesOfType("connectionInfoChanged")
      const last = infos[infos.length - 1]
      expect(last.canUpload).toBe(false)
      expect(last.uploadMode).toBe("unavailable")
      expect(last.uploadUnavailableReason).toBe("stamp-not-usable")
      const internals = proxy as unknown as { ensureCanUpload(): void }
      expect(() => internals.ensureCanUpload()).toThrow(/not usable/)
    },
  )

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
    expect(last.uploadUnavailableReason).toBeUndefined()
    expect(last.identity?.name).toBe("Partition Test Account")
    // The address an app buys a batch for (#815): the account's own postage
    // signer, derived from the derivation key the way the drive flows do.
    expect(last.identity?.postageSignerAddress).toBe(
      new PrivateKey(derivePostageSignerKeySync(account.derivationKey))
        .publicKey()
        .address()
        .toHex(),
    )

    // The default stamp was bound from the hydrated account view.
    const createCalls = vi.mocked(UtilizationAwareStamper.create).mock.calls
    expect(createCalls.length).toBeGreaterThanOrEqual(1)
    expect(String(createCalls[0][1])).toBe(BATCH_ID_HEX)
  })

  // A partitioned session keeps its device id in the iframe's OWN (partitioned)
  // storage, which nothing outside the iframe can read. Surfacing the id is what
  // let a page answer whether that storage survives a reload — on real Safari it
  // does (#584, measured on iOS 18.7 / Safari 26.6). What is still unmeasured is
  // ITP's ~30-day eviction of a dormant account, which would make every session
  // a new device in the roster (#570).
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
        batchId: BATCH_ID_HEX,
        fromDeviceId: "peer-device",
        requestId: "00000000",
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
        batchId: BATCH_ID_HEX,
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

    function postRequest(channel: BroadcastChannel, requestId: string): void {
      channel.postMessage({
        type: "lease-request",
        accountId: ACCOUNT_ID,
        batchId: BATCH_ID_HEX,
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

    it("drops a lease-request that carries no id at parse", () => {
      // Every holder takes a rank; there is no unranked answer any more.
      const result = BusMessageSchema.safeParse({
        type: "lease-request",
        accountId: ACCOUNT_ID,
        batchId: BATCH_ID_HEX,
        fromDeviceId: "peer-device",
      })
      expect(result.success).toBe(false)
    })

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
            batchId: BATCH_ID_HEX,
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
          batchId: BATCH_ID_HEX,
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
          batchId: BATCH_ID_HEX,
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
          batchId: BATCH_ID_HEX,
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

  it("ignores its own lease messages, and other accounts' and batches'", async () => {
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
        batchId: BATCH_ID_HEX,
        fromDeviceId: ownDeviceId,
        requestId: "00000000",
      })
      busChannel.postMessage({
        type: "lease-request",
        accountId: "bb".repeat(20),
        batchId: BATCH_ID_HEX,
        fromDeviceId: "peer-device",
        requestId: "00000000",
      })
      busChannel.postMessage({
        type: "lease-released",
        accountId: "bb".repeat(20),
        batchId: BATCH_ID_HEX,
        partition: 0,
        fromDeviceId: "peer-device",
      })
      // A lane is one partition of ONE batch (#589), so a waiter on another
      // batch contends with nothing this holder has. Answering it would drop a
      // lease that helps neither side — and per-app stamp overrides make two
      // live coordinators on two batches an ordinary account, not a
      // multi-batch hypothetical.
      busChannel.postMessage({
        type: "lease-request",
        accountId: "aa".repeat(20),
        batchId: "dd".repeat(32),
        fromDeviceId: "peer-device",
        requestId: "00000000",
      })
      busChannel.postMessage({
        type: "lease-released",
        accountId: "aa".repeat(20),
        batchId: "dd".repeat(32),
        partition: 0,
        fromDeviceId: "peer-device",
      })
      // A matching request afterwards proves the earlier ones were dropped
      // (not merely still in flight).
      busChannel.postMessage({
        type: "lease-request",
        accountId: "aa".repeat(20),
        batchId: BATCH_ID_HEX,
        fromDeviceId: "peer-device",
        requestId: "00000000",
      })
      await vi.waitFor(() =>
        expect(coordinator.yieldForPeer).toHaveBeenCalledTimes(1),
      )
      expect(coordinator.notifySlotMaybeFree).not.toHaveBeenCalled()
    } finally {
      busChannel.close()
    }
  })

  // #635: the handed-over session used to live only in memory, so a plain
  // reload logged the user out of the dApp — on Safari, where partitioned is
  // the ordinary mode, that is every reload. It is kept now, under the same
  // 30-day deadline the unpartitioned path enforces out of shared storage.
  describe("a session that survives a reload", () => {
    async function connectPartitioned(): Promise<void> {
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(makeSyncedAccount()),
      })
    }

    function storedSession(): Record<string, unknown> | undefined {
      const raw = localStorageFake.getItem(
        partitionSessionStorageKey(PARENT_ORIGIN),
      )
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
    }

    it("comes back as a writer, without a second popup", async () => {
      await connectPartitioned()
      expect(storedSession()).toBeTruthy()

      await reload()

      const infos = messagesOfType("connectionInfoChanged")
      const last = infos[infos.length - 1]
      expect(last.storagePartitioned).toBe(true)
      expect(last.uploadMode).toBe("user-stamp")
      expect(last.canUpload).toBe(true)
      expect(last.identity?.name).toBe("Partition Test Account")
      // The popup is what a reload used to require; nothing opened one here.
      expect(window.open).not.toHaveBeenCalled()
    })

    it("keeps the deadline the session was given, not a fresh one", async () => {
      await connectPartitioned()
      const record = storedSession()!
      // 30 days, give or take the test's own runtime.
      const remaining = (record.connectedUntil as number) - Date.now()
      expect(remaining).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)
      expect(remaining).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000)
    })

    it("refuses a session stored for another parent origin", async () => {
      await connectPartitioned()
      const record = storedSession()!
      localStorageFake.setItem(
        partitionSessionStorageKey(PARENT_ORIGIN),
        JSON.stringify({ ...record, parentOrigin: "https://evil.example.com" }),
      )

      await reload()

      const infos = messagesOfType("connectionInfoChanged")
      expect(infos[infos.length - 1]?.canUpload).toBe(false)
    })

    it("refuses an expired session, and forgets it", async () => {
      await connectPartitioned()
      const record = storedSession()!
      localStorageFake.setItem(
        partitionSessionStorageKey(PARENT_ORIGIN),
        JSON.stringify({ ...record, connectedUntil: Date.now() - 1 }),
      )

      await reload()

      expect(storedSession()).toBeUndefined()
      const infos = messagesOfType("connectionInfoChanged")
      expect(infos[infos.length - 1]?.canUpload).toBe(false)
    })

    // Storage is partitioned by (iframe origin, top-level SITE), and a site
    // ignores the subdomain — so two dApps under example.com share one store.
    // The saved session used to live under a single fixed key there, so the
    // second dApp to connect overwrote the first one's, and the first came back
    // to a record belonging to somebody else, read it as "no session", and
    // needed the popup again. Both of them, on every reload (#671).
    it("keeps its session when a same-site dApp connects too", async () => {
      await connectPartitioned()
      expect(storedSession()).toBeTruthy()

      // The sibling dApp, in its own iframe but the same partitioned store.
      proxy.destroy()
      mountProxy()
      const siblingChallenge = await startPartitionedConnect(SIBLING_ORIGIN)
      await sendSetSecret(
        siblingChallenge,
        { account: serializeSyncedAccount(makeSyncedAccount()) },
        SIBLING_ORIGIN,
      )

      // Back to the first dApp: it must still come up as a writer.
      proxy.destroy()
      mountProxy()
      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )

      const infos = messagesOfType("connectionInfoChanged")
      const last = infos[infos.length - 1]
      expect(last.storagePartitioned).toBe(true)
      expect(last.canUpload).toBe(true)
    })

    it("forgets the session when the connection ends", async () => {
      await connectPartitioned()
      await dispatch(
        { type: "disconnect", requestId: "r9" },
        PARENT_ORIGIN,
        parentWindow,
      )
      expect(storedSession()).toBeUndefined()
    })

    // The deadline cannot see a revoke made while the tab was closed — the
    // re-handshake used to be what caught that, and persisting removes it. So
    // a restored session checks the account's own Swarm state in the
    // background and tears itself down on a tombstone.
    it("ends a restored session the account has since revoked", async () => {
      const connectedAt = Date.now()
      await connectPartitionedAt(connectedAt)
      const revoked = makeSyncedAccount()
      foldedFromSwarm.value = {
        account: {
          ...revoked,
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              lastConnectedAt: connectedAt,
              revokedAt: connectedAt + 1,
            },
          ],
        },
        devices: [],
      }

      await reload()

      await vi.waitFor(() => {
        const infos = messagesOfType("connectionInfoChanged")
        expect(infos[infos.length - 1]?.canUpload).toBe(false)
      })
      expect(storedSession()).toBeUndefined()
      foldedFromSwarm.value = undefined
    })

    // Disconnect and Remove both end a session, and both state it on the entry
    // — but only Remove wrote the marker this check looked at. So a Disconnect
    // made while the tab was closed came back still connected and still able to
    // upload, for the rest of the session's 30 days (#667).
    it("ends a restored session the account has since disconnected", async () => {
      const connectedAt = Date.now()
      await connectPartitionedAt(connectedAt)
      foldedFromSwarm.value = {
        account: {
          ...makeSyncedAccount(),
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              lastConnectedAt: connectedAt,
              disconnectedAt: connectedAt + 1,
            },
          ],
        },
        devices: [],
      }

      await reload()

      await vi.waitFor(() => {
        const infos = messagesOfType("connectionInfoChanged")
        expect(infos[infos.length - 1]?.canUpload).toBe(false)
      })
      expect(storedSession()).toBeUndefined()
      foldedFromSwarm.value = undefined
    })

    // The other half of the rule, and the reason the comparison exists: a
    // disconnect this session already reconnected past says nothing about it.
    // Waiting on the fold first, so this proves the check RAN and declined
    // rather than that it never happened.
    it("keeps a restored session it reconnected after the disconnect", async () => {
      const connectedAt = Date.now()
      await connectPartitionedAt(connectedAt)
      foldedFromSwarm.value = {
        account: {
          ...makeSyncedAccount(),
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              lastConnectedAt: connectedAt,
              disconnectedAt: connectedAt - 1000,
            },
          ],
        },
        devices: [],
      }
      vi.mocked(foldAccountFromSwarm).mockClear()

      await reload()

      await vi.waitFor(() =>
        expect(vi.mocked(foldAccountFromSwarm)).toHaveBeenCalled(),
      )
      // The CALL is recorded before the continuation that would tear the
      // session down, so waiting on it alone would also pass if the check had
      // simply not got there yet. Settle the read and drain the microtasks
      // behind it, and a surviving session means the check ran and declined.
      await vi.mocked(foldAccountFromSwarm).mock.results.at(-1)?.value
      await Promise.resolve()
      await Promise.resolve()

      const infos = messagesOfType("connectionInfoChanged")
      expect(infos[infos.length - 1]?.canUpload).toBe(true)
      expect(storedSession()).toBeTruthy()
      foldedFromSwarm.value = undefined
    })

    /** The restore's background check ran and declined: the session is still up. */
    async function expectCheckKeptSession(): Promise<void> {
      await vi.waitFor(() =>
        expect(vi.mocked(foldAccountFromSwarm)).toHaveBeenCalled(),
      )
      await vi.mocked(foldAccountFromSwarm).mock.results.at(-1)?.value
      await Promise.resolve()
      await Promise.resolve()
      const infos = messagesOfType("connectionInfoChanged")
      expect(infos[infos.length - 1]?.canUpload).toBe(true)
      expect(storedSession()).toBeTruthy()
    }

    // The published state can predate this session: with an expired drive
    // the identity site cannot publish the connect, so the last snapshot on
    // Swarm never saw it. An entry is only ever tombstoned, never deleted, so
    // a missing one means exactly that — the state has nothing to say about
    // a connection it never heard of — and must not read as a removal.
    it("keeps a restored session the published state has no entry for", async () => {
      await connectPartitionedAt(Date.now())
      foldedFromSwarm.value = {
        account: { ...makeSyncedAccount(), connectedApps: [] },
        devices: [],
      }
      vi.mocked(foldAccountFromSwarm).mockClear()

      await reload()

      await expectCheckKeptSession()
      foldedFromSwarm.value = undefined
    })

    // Same for a removal the published state still shows from before this
    // session: the reconnect answered it (`connectApp` clears the tombstone),
    // and only a removal newer than our connection can end it — the clock the
    // Disconnect check below already compares.
    it("keeps a restored session it reconnected after the removal", async () => {
      const connectedAt = Date.now()
      await connectPartitionedAt(connectedAt)
      foldedFromSwarm.value = {
        account: {
          ...makeSyncedAccount(),
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              lastConnectedAt: connectedAt - 1000,
              revokedAt: connectedAt - 1000,
            },
          ],
        },
        devices: [],
      }
      vi.mocked(foldAccountFromSwarm).mockClear()

      await reload()

      await expectCheckKeptSession()
      foldedFromSwarm.value = undefined
    })

    // A reload is not a connection, and `hydratePartitionAccount` used to
    // record it as one. #668 worked around that at the one call site that
    // needed the true instant; every other reader still got "just now" (#670).
    it("keeps the connect instant it was handed, across a reload", async () => {
      const connectedAt = Date.now() - 60_000
      await connectPartitionedAt(connectedAt)

      await reload()

      const { partitionAccount } = proxy as unknown as {
        partitionAccount: SignedInAccount | undefined
      }
      expect(
        partitionAccount?.connectedApps.find(
          (app) => app.appUrl === PARENT_ORIGIN,
        )?.lastConnectedAt,
      ).toBe(connectedAt)
    })
  })

  // A revoke reaches a live proxy only through the browser `storage` event, and
  // `handleAccountStorageChange` skips the disconnect while partitioned — the
  // iframe cannot see connected apps. So on Safari a revoked session kept its
  // hydrated account view, stamp signer keys included, for the life of the
  // page. `account-delta` is the push channel that closes that.
  describe("account-delta from a peer", () => {
    /** The batch a replacement default stamp lives on. */
    const OTHER_BATCH_ID_HEX = "dd".repeat(32)
    /** Long enough that two overlapping reconciles are observably overlapping,
     *  short enough not to slow the suite. */
    const SLOW_REFRESH_MS = 30

    /** The wire form: what a publisher puts on the bus. */
    function accountDelta(overrides?: {
      accountId?: string
      connectedApps?: ConnectedApp[]
      postageStamps?: PostageStamp[]
      defaultPostageStampBatchID?: string
      defaultStampAt?: number
      lastModified?: number
    }): Record<string, unknown> {
      const account = makeSyncedAccount()
      return {
        type: "account-delta",
        snapshot: serializeAccountStateSnapshot({
          accountId: overrides?.accountId ?? account.id.toHex(),
          metadata: {
            accountName: account.name,
            defaultPostageStampBatchID:
              overrides?.defaultPostageStampBatchID ?? BATCH_ID_HEX,
            defaultStampAt: overrides?.defaultStampAt,
            publicKey: account.publicKey,
            settings: undefined,
            createdAt: account.createdAt,
            lastModified: overrides?.lastModified ?? Date.now(),
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
        disconnectedAt: now,
        revokedAt: now,
      }
    }

    /** A plain Disconnect as the UI writes it: auth material cleared, but no
     *  tombstone — the end is stated by a `disconnectedAt` newer than the
     *  connection the reader holds. */
    function disconnected(appUrl: string, at: number): ConnectedApp {
      return {
        appUrl,
        appName: "dApp",
        lastConnectedAt: at - 1000,
        appSecret: undefined,
        connectedUntil: undefined,
        disconnectedAt: at,
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

    // #711: the permissions popup. A partitioned session is handed the new
    // grant by the popup it opened, as the delta the bus would carry.
    describe("a permissions request", () => {
      /** Past the popup watch's start delay and one poll. */
      const POPUP_WATCH_MS = 3000

      async function requestPermissions(popup: Window | null): Promise<string> {
        vi.mocked(window.open).mockReturnValueOnce(popup)
        await dispatch(
          {
            type: "requestPermissions",
            requestId: "p1",
            permissions: { drives: [{ kind: "scratch" }] },
          },
          PARENT_ORIGIN,
          parentWindow,
        )
        return vi.mocked(window.open).mock.calls.at(-1)![0] as string
      }

      it(
        "opens the permissions page for this session's account, and answers once it closes",
        async () => {
          const busChannel = await hydratedSession()
          busChannel.close()

          const url = await requestPermissions({ closed: true } as Window)

          const params = new URLSearchParams(url.split("#")[1])
          expect(url).toContain("/permissions#")
          expect(params.get("account")).toBe(makeSyncedAccount().id.toHex())
          expect(JSON.parse(params.get("permissions")!)).toEqual({
            drives: [{ kind: "scratch" }],
          })
          expect(messagesOfType("requestPermissionsResponse")).toEqual([
            expect.objectContaining({ requestId: "p1", opened: true }),
          ])
        },
        POPUP_WATCH_MS * 2,
      )

      it("answers at once when the popup was blocked", async () => {
        const busChannel = await hydratedSession()
        busChannel.close()

        await requestPermissions(null)

        expect(messagesOfType("requestPermissionsResponse")).toEqual([
          expect.objectContaining({ requestId: "p1", opened: false }),
        ])
      })

      /** A hand-off from `source` (the popup by default) revoking this app. */
      const handOff = (
        challenge: string,
        overrides: { appOrigin?: string; source?: unknown } = {},
      ) =>
        dispatch(
          {
            type: "grantUpdated",
            appOrigin: overrides.appOrigin ?? PARENT_ORIGIN,
            challenge,
            delta: accountDelta({ connectedApps: [revoked(PARENT_ORIGIN)] }),
          },
          ID_ORIGIN,
          overrides.source ?? popup,
        )
      /** The hand-off was folded: the delta revokes the app, which disconnects. */
      const folded = () => messagesOfType("disconnectResponse")
      const pendingGrants = () =>
        (proxy as unknown as { pendingGrants: Map<string, Window> })
          .pendingGrants
      let popup: { closed: boolean }

      beforeEach(() => {
        popup = { closed: false }
      })

      it(
        "folds the popup's hand-off once: from that window, with its challenge, for this app",
        async () => {
          const busChannel = await hydratedSession()
          busChannel.close()
          const request = requestPermissions(popup as unknown as Window)
          await vi.waitFor(() => expect(window.open).toHaveBeenCalled())
          const url = vi.mocked(window.open).mock.calls.at(-1)![0] as string
          const challenge = new URLSearchParams(url.split("#")[1]).get(
            "challenge",
          )!

          await handOff("not-this-popup")
          await handOff(challenge, { appOrigin: "https://other.example.com" })
          await handOff(challenge, { source: {} })
          await flushBus()
          expect(folded()).toHaveLength(0)
          expect(pendingGrants().has(challenge)).toBe(true)

          await handOff(challenge)
          await vi.waitFor(() => expect(folded()).toHaveLength(1))
          // One shot: the same challenge folds nothing twice.
          expect(pendingGrants().has(challenge)).toBe(false)

          popup.closed = true
          await request
        },
        POPUP_WATCH_MS * 2,
      )

      it(
        "forgets the challenge once the popup is closed",
        async () => {
          const busChannel = await hydratedSession()
          busChannel.close()
          popup.closed = true
          const url = await requestPermissions(popup as unknown as Window)
          const challenge = new URLSearchParams(url.split("#")[1]).get(
            "challenge",
          )!

          await handOff(challenge)
          await flushBus()
          expect(folded()).toHaveLength(0)
        },
        POPUP_WATCH_MS * 2,
      )
    })

    // The plan's own claim (#862): a live "all" grant learns of a drive added
    // after the handover from the delta alone — the handover could not carry
    // a drive that did not exist yet.
    it('lists a drive a delta adds to a live "all" grant', async () => {
      const account = makeSyncedAccount()
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount({
          ...account,
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              lastConnectedAt: Date.now(),
              drives: "all",
              drivesAt: Date.now(),
            },
          ],
        }),
      })
      await awaitBusJoin()
      const added: PostageStamp = {
        ...account.postageStamps[0],
        batchID: new BatchId(OTHER_BATCH_ID_HEX),
        signerKey: new PrivateKey("44".repeat(32)),
        createdAt: Date.now(),
      }
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage(
          accountDelta({ postageStamps: [...account.postageStamps, added] }),
        )
        await vi.waitFor(async () => {
          await dispatch(
            { type: "getDrives", requestId: `g-${Date.now()}` },
            PARENT_ORIGIN,
            parentWindow,
          )
          const drives = messagesOfType("getDrivesResponse").at(-1)!.drives as {
            batchID: string
          }[]
          expect(drives.map((drive) => drive.batchID)).toEqual([
            BATCH_ID_HEX,
            OTHER_BATCH_ID_HEX,
          ])
        })
      } finally {
        busChannel.close()
      }
    })

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

    // The other end of #670. `verifyRestoredSession` has nothing to read for an
    // account that never published — no drive, no feed — so the live overlap on
    // this bus is the only thing left that can deliver a Disconnect made while
    // the tab was closed. It could not: the restore restamped `lastConnectedAt`,
    // so `restoreLocalSessionFields` read the disconnect as older than "our"
    // connection, handed the secret back, and the session stayed undead for the
    // rest of its 30 days. A Remove was caught (a tombstone needs no clock),
    // which is why only the Disconnect went missing.
    it("ends a restored session a peer disconnected while the tab was closed", async () => {
      const connectedAt = Date.now() - 60_000
      await connectPartitionedAt(connectedAt)
      await reload()
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        busChannel.postMessage(
          accountDelta({
            connectedApps: [disconnected(PARENT_ORIGIN, connectedAt + 1000)],
          }),
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

    // Nothing expires a session live: `connectedUntil` is set once, at connect,
    // and a partitioned session's is hydrated from the popup — so a page open
    // past its deadline keeps uploading (`ensureCanUpload` reads the secret, not
    // the clock). If a lapsed deadline also cost it every incoming delta, the
    // revoke that should end it would be the one message it cannot hear.
    it("disconnects an expired partitioned session on a revoke", async () => {
      const busChannel = await hydratedSession()
      const internals = proxy as unknown as {
        partitionAccount: SignedInAccount | undefined
      }
      const hydrated = internals.partitionAccount!
      internals.partitionAccount = {
        ...hydrated,
        connectedApps: hydrated.connectedApps.map((app) =>
          app.appUrl === PARENT_ORIGIN
            ? { ...app, connectedUntil: Date.now() - 1000 }
            : app,
        ),
      }
      try {
        busChannel.postMessage(
          accountDelta({ connectedApps: [revoked(PARENT_ORIGIN)] }),
        )
        await vi.waitFor(() =>
          expect(messagesOfType("disconnectResponse")).toHaveLength(1),
        )
      } finally {
        busChannel.close()
      }
    })

    // A default-stamp change is two moves in one delta: the old stamp is
    // tombstoned and the pointer moves to a new one. Fold the collections
    // without the metadata and the pointer stays on the tombstone —
    // `resolveStampForApp` then resolves nothing, the stamper is cleared, and
    // the session cannot upload for the page's life with the replacement stamp
    // and its signer key already in hand.
    it("rebinds the stamper when a delta moves the default stamp", async () => {
      const busChannel = await hydratedSession()
      const replacementKey = "ab".repeat(32)
      try {
        const stamp = makeSyncedAccount().postageStamps[0]
        const now = Date.now()
        busChannel.postMessage(
          accountDelta({
            defaultPostageStampBatchID: OTHER_BATCH_ID_HEX,
            defaultStampAt: now,
            postageStamps: [
              { ...stamp, deletedAt: now, updatedAt: now },
              {
                ...stamp,
                batchID: new BatchId(OTHER_BATCH_ID_HEX),
                signerKey: new PrivateKey(replacementKey),
                createdAt: now,
              },
            ],
          }),
        )
        await vi.waitFor(() =>
          expect(
            String(
              vi.mocked(UtilizationAwareStamper.create).mock.calls.at(-1)![1],
            ),
          ).toBe(OTHER_BATCH_ID_HEX),
        )
        const lastCall = vi
          .mocked(UtilizationAwareStamper.create)
          .mock.calls.at(-1)!
        expect(String(lastCall[0])).toBe(replacementKey)
        const infos = messagesOfType("connectionInfoChanged")
        expect(infos[infos.length - 1].canUpload).toBe(true)
      } finally {
        busChannel.close()
      }
    })

    // The pool's workers hold the signer key and the pool signs for one
    // stamper's batch, so it lives exactly as long as that stamper does.
    describe("the stamp worker pool", () => {
      const POOL_SIZE = 2

      function getWorkerPool(): Promise<unknown> {
        const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
          .value as {
          deps: { getWorkerPool: (count?: number) => Promise<unknown> }
        }
        return deps.getWorkerPool(POOL_SIZE)
      }

      beforeEach(() => {
        FakeStampWorker.instances = []
        vi.stubGlobal("Worker", FakeStampWorker)
      })

      it("is rebuilt with the new signer when a delta moves the default stamp", async () => {
        const busChannel = await hydratedSession()
        const replacementKey = "ab".repeat(32)
        try {
          const first = await getWorkerPool()
          const firstWorkers = [...FakeStampWorker.instances]
          expect(firstWorkers).toHaveLength(POOL_SIZE)

          const stamp = makeSyncedAccount().postageStamps[0]
          const now = Date.now()
          busChannel.postMessage(
            accountDelta({
              defaultPostageStampBatchID: OTHER_BATCH_ID_HEX,
              defaultStampAt: now,
              postageStamps: [
                { ...stamp, deletedAt: now, updatedAt: now },
                {
                  ...stamp,
                  batchID: new BatchId(OTHER_BATCH_ID_HEX),
                  signerKey: new PrivateKey(replacementKey),
                  createdAt: now,
                },
              ],
            }),
          )
          await vi.waitFor(() =>
            expect(
              String(
                vi.mocked(UtilizationAwareStamper.create).mock.calls.at(-1)![1],
              ),
            ).toBe(OTHER_BATCH_ID_HEX),
          )
          await vi.waitFor(() =>
            expect(firstWorkers.every((worker) => worker.terminated)).toBe(
              true,
            ),
          )

          const second = await getWorkerPool()

          expect(second).not.toBe(first)
          const secondWorkers = FakeStampWorker.instances.slice(POOL_SIZE)
          expect(secondWorkers).toHaveLength(POOL_SIZE)
          expect(secondWorkers.map((worker) => worker.signerKeyHex)).toEqual(
            Array.from({ length: POOL_SIZE }, () => replacementKey),
          )
        } finally {
          busChannel.close()
        }
      })

      it("does not keep the signer key in its workers past a disconnect", async () => {
        const busChannel = await hydratedSession()
        busChannel.close()
        await getWorkerPool()
        expect(FakeStampWorker.instances).toHaveLength(POOL_SIZE)

        await dispatch(
          { type: "disconnect", requestId: "r-pool" },
          PARENT_ORIGIN,
          parentWindow,
        )

        expect(
          FakeStampWorker.instances.every((worker) => worker.terminated),
        ).toBe(true)
      })
    })

    // #745 review: a renewal (top-up) keeps the batch id and the signer key
    // and only moves `batchTTL` / `updatedAt`, so a refresh guard keyed on the
    // batch alone keeps refusing uploads until a full reload — the very
    // remediation the error message tells the user to try.
    it("lifts the refusal when a delta renews the same expired drive", async () => {
      const account = makeSyncedAccount()
      const [stamp] = account.postageStamps
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount({
          ...account,
          postageStamps: [
            { ...stamp, batchTTL: 60, updatedAt: Date.now() - 120_000 },
          ],
        }),
      })
      await awaitBusJoin()
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        let infos = messagesOfType("connectionInfoChanged")
        expect(infos[infos.length - 1].uploadUnavailableReason).toBe(
          "stamp-expired",
        )

        busChannel.postMessage(
          accountDelta({
            postageStamps: [{ ...stamp, batchTTL: 600, updatedAt: Date.now() }],
          }),
        )
        await vi.waitFor(() => {
          infos = messagesOfType("connectionInfoChanged")
          expect(infos[infos.length - 1].canUpload).toBe(true)
        })
        expect(infos[infos.length - 1].uploadMode).toBe("user-stamp")
      } finally {
        busChannel.close()
      }
    })

    // #745 review: expiry is a function of the clock, not of the last
    // resolution event. A tab left open past the drive's lifetime must refuse
    // the write itself rather than let Bee refuse the lease claim.
    it("refuses an upload once the drive's lifetime runs out in an open session", async () => {
      const account = makeSyncedAccount()
      const [stamp] = account.postageStamps
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount({
          ...account,
          postageStamps: [{ ...stamp, batchTTL: 60, updatedAt: Date.now() }],
        }),
      })
      const internals = proxy as unknown as {
        ensureCanUpload(): void
        buildConnectionInfo(): {
          canUpload: boolean
          uploadUnavailableReason?: string
        }
      }
      expect(() => internals.ensureCanUpload()).not.toThrow()
      expect(internals.buildConnectionInfo().canUpload).toBe(true)

      vi.setSystemTime(Date.now() + 61_000)
      try {
        expect(() => internals.ensureCanUpload()).toThrow(/expired/)
        expect(() => internals.ensureCanUpload()).toThrow(
          expect.objectContaining({
            code: "upload-unavailable",
            reason: "stamp-expired",
          }),
        )
        const info = internals.buildConnectionInfo()
        expect(info.canUpload).toBe(false)
        expect(info.uploadUnavailableReason).toBe("stamp-expired")
      } finally {
        vi.useRealTimers()
      }
    })

    // The stored session (#635) is written at the handover, so without a
    // re-save the fold above lives only in memory: the next reload comes back
    // on the tombstoned stamp and its superseded signer key, and uploads with
    // it until some later delta happens to arrive while the page is open.
    it("re-persists the stored session after a delta moves the default stamp", async () => {
      const busChannel = await hydratedSession()
      const before = JSON.parse(
        localStorageFake.getItem(partitionSessionStorageKey(PARENT_ORIGIN))!,
      ) as { connectedUntil: number }
      try {
        const stamp = makeSyncedAccount().postageStamps[0]
        const now = Date.now()
        busChannel.postMessage(
          accountDelta({
            defaultPostageStampBatchID: OTHER_BATCH_ID_HEX,
            defaultStampAt: now,
            postageStamps: [
              { ...stamp, deletedAt: now, updatedAt: now },
              {
                ...stamp,
                batchID: new BatchId(OTHER_BATCH_ID_HEX),
                signerKey: new PrivateKey("ab".repeat(32)),
                createdAt: now,
              },
            ],
          }),
        )
        await vi.waitFor(() => {
          const stored = JSON.parse(
            localStorageFake.getItem(
              partitionSessionStorageKey(PARENT_ORIGIN),
            )!,
          ) as {
            connectedUntil: number
            data: { account: { defaultPostageStampBatchID: string } }
          }
          expect(stored.data.account.defaultPostageStampBatchID).toBe(
            OTHER_BATCH_ID_HEX,
          )
          // The deadline is the handover's, not a fresh one: re-persisting on
          // every delta must not let a session extend itself indefinitely.
          expect(stored.connectedUntil).toBe(before.connectedUntil)
        })
      } finally {
        busChannel.close()
      }
    })

    // A fold states what the two sides already say; it is not a change made
    // here. `accountAsStateSnapshot` reads `lastModified` back as the snapshot
    // clock on the NEXT fold, so restamping it with `Date.now()` would let this
    // session outrank a peer's genuine edit purely by having consumed a message.
    it("keeps the newer of the two clocks on a fold, not a fresh one", async () => {
      const busChannel = await hydratedSession()
      const internals = proxy as unknown as {
        partitionAccount: SignedInAccount | undefined
      }
      const localAt = internals.partitionAccount!.lastModified!
      try {
        const stamp = makeSyncedAccount().postageStamps[0]
        busChannel.postMessage(
          accountDelta({
            lastModified: localAt - 10_000,
            // The second stamp has to be one this app's grant names, or the
            // narrowing (#578) drops it and the fold is unobservable here: the
            // delta grants the app both drives in the same message.
            connectedApps: [
              {
                appUrl: PARENT_ORIGIN,
                appName: "dApp",
                lastConnectedAt: Date.now(),
                drives: [stamp.batchID, new BatchId(OTHER_BATCH_ID_HEX)],
                drivesAt: Date.now() + 1,
              },
            ],
            postageStamps: [
              stamp,
              {
                ...stamp,
                batchID: new BatchId(OTHER_BATCH_ID_HEX),
                createdAt: localAt - 10_000,
              },
            ],
          }),
        )
        await vi.waitFor(() =>
          expect(internals.partitionAccount!.postageStamps).toHaveLength(2),
        )
        expect(internals.partitionAccount!.lastModified).toBe(localAt)
      } finally {
        busChannel.close()
      }
    })

    // `includeEnded` makes every historical entry for this origin eligible,
    // across every account, and `isConnectionValid` is only a deadline check.
    // Ranking on `lastConnectedAt` alone then lets a long-dead session outrank
    // a live one from another account — and the delta addressed to the live
    // account is dropped as "not this session's".
    it("prefers a valid connection over a more recent ended one", async () => {
      await unpartitionedSession()
      const now = Date.now()
      const stored = (
        account: Partial<SyncedAccount>,
        app: Partial<ConnectedApp>,
      ): Record<string, unknown> =>
        serializeAccount({
          ...makeSyncedAccount(),
          ...account,
          connectedApps: [
            {
              appUrl: PARENT_ORIGIN,
              appName: "dApp",
              appSecret: "44".repeat(32),
              lastConnectedAt: now,
              connectedUntil: now + 60_000,
              ...app,
            },
          ],
          access: {
            type: "password",
            kdfSalt: "ab".repeat(16),
            kdfIterations: 100_000,
          },
          encryptedSeed: "00".repeat(48),
        } as SignedInAccount)
      localStorageFake.setItem(
        STORAGE_KEY_ACCOUNTS,
        JSON.stringify({
          version: 1,
          data: [
            // Still connected, but it connected FIRST.
            stored(
              { id: new EthAddress("aa".repeat(20)) },
              {
                lastConnectedAt: now - 60_000,
              },
            ),
            // Lapsed, and the most recent thing on this origin.
            stored(
              {
                id: new EthAddress("bb".repeat(20)),
                derivationKey: OTHER_DERIVATION_KEY,
              },
              { lastConnectedAt: now, connectedUntil: now - 1000 },
            ),
          ],
        }),
      )

      const found = (
        proxy as unknown as {
          findConnectionForParent(options?: {
            includeEnded: boolean
          }): { account: SignedInAccount } | undefined
        }
      ).findConnectionForParent({ includeEnded: true })
      expect(found?.account.id.toHex()).toBe(
        new EthAddress("aa".repeat(20)).toHex(),
      )
    })

    // A fold's reconcile is the same shared-state mutation a storage event's is
    // (`refreshStampFromStorage` rebinds the stamper across awaits), so it
    // belongs on the same queue — whose catch is also the only thing between a
    // failed refresh and an unhandled rejection: the bus dispatch's try/catch
    // only covers what throws synchronously.
    it("contains a failing bus reconcile instead of rejecting unhandled", async () => {
      const busChannel = await hydratedSession()
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
      process.on("unhandledRejection", onUnhandled)
      const internals = proxy as unknown as {
        refreshStampFromStorage(): Promise<void>
      }
      internals.refreshStampFromStorage = vi.fn(() =>
        Promise.reject(new Error("refresh failed")),
      )
      try {
        busChannel.postMessage(accountDelta())
        await flushBus()
        await flushBus()
        expect(unhandled).toHaveLength(0)
        expect(
          errors.mock.calls.some(([message]) =>
            String(message).includes("applyAccountDelta"),
          ),
        ).toBe(true)
      } finally {
        process.off("unhandledRejection", onUnhandled)
        busChannel.close()
      }
    })

    it("serializes the reconciles two folds trigger", async () => {
      const busChannel = await hydratedSession()
      let active = 0
      let peak = 0
      let calls = 0
      const internals = proxy as unknown as {
        refreshStampFromStorage(): Promise<void>
      }
      internals.refreshStampFromStorage = vi.fn(async () => {
        calls += 1
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, SLOW_REFRESH_MS))
        active -= 1
      })
      try {
        busChannel.postMessage(accountDelta())
        busChannel.postMessage(accountDelta())
        await vi.waitFor(() => expect(calls).toBe(2))
        expect(peak).toBe(1)
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

    // The shell inside the proxy iframe folds a peer's delta into the shared
    // document, and the manager tells the proxy's own instance in the same
    // window. That write is the peer's change, not this device's: publishing
    // it back is the echo that kept two devices publishing at each other every
    // few seconds (#707). Written through a manager, as the shell does, so the
    // subscribe wiring that carries the flag is what is under test.
    it("does not publish a delta for a write the shell marked noRepublish", async () => {
      const busChannel = await hydratedSession()
      const published: Record<string, unknown>[] = []
      busChannel.onmessage = (event) =>
        published.push(event.data as Record<string, unknown>)
      try {
        const shell = createAccountsStorageManager()
        shell.save(shell.load(), { noRepublish: true })

        // Past the publish debounce, with room to spare.
        await new Promise((resolve) =>
          setTimeout(resolve, PUBLISH_DEBOUNCE_MS + 1000),
        )
        expect(
          published.filter((m) => m.type === "account-delta"),
        ).toHaveLength(0)
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

    // A narrowed handover is undone by the first delta if the fold keeps
    // everything it is sent: the publisher is an unpartitioned context, and it
    // publishes the whole collection. The session may hold only what its own
    // pointers name (#578).
    it("does not accumulate stamps it cannot spend from a delta", async () => {
      const busChannel = await hydratedSession()
      const stamp = makeSyncedAccount().postageStamps[0]
      const foreign = {
        ...stamp,
        batchID: new BatchId("dd".repeat(32)),
        signerKey: new PrivateKey("ee".repeat(32)),
        updatedAt: Date.now(),
      }
      try {
        busChannel.postMessage(
          accountDelta({ postageStamps: [stamp, foreign] }),
        )
        await flushBus()

        const held = (
          proxy as unknown as {
            partitionAccount: {
              postageStamps: { batchID: { toHex(): string } }[]
            }
          }
        ).partitionAccount.postageStamps
        expect(held.map((s) => s.batchID.toHex())).toEqual([BATCH_ID_HEX])
      } finally {
        busChannel.close()
      }
    })

    /** What the narrowing filters BY has to be what the merge just decided —
     *  the delta carries both the new grant and the stamp it names, and a
     *  narrowing that reads the pre-merge grant throws the stamp away while
     *  keeping the grant. `resolveStampForApp` then resolves nothing and the
     *  session cannot upload, until some unrelated change happens to publish
     *  again. */
    function otherStamp(): PostageStamp {
      return {
        ...makeSyncedAccount().postageStamps[0],
        batchID: new BatchId(OTHER_BATCH_ID_HEX),
        signerKey: new PrivateKey("ee".repeat(32)),
        updatedAt: Date.now(),
      }
    }

    it("keeps the stamp a delta re-points this app at", async () => {
      const busChannel = await hydratedSession()
      try {
        busChannel.postMessage(
          accountDelta({
            connectedApps: [
              {
                appUrl: PARENT_ORIGIN,
                appName: "dApp",
                lastConnectedAt: Date.now(),
                // Strictly newer than the hydrated entry, so the fold cannot
                // tie on a same-millisecond clock and keep the local grant.
                drivesAt: Date.now() + 1,
                drives: [new BatchId(OTHER_BATCH_ID_HEX)],
              },
            ],
            postageStamps: [makeSyncedAccount().postageStamps[0], otherStamp()],
          }),
        )
        await flushBus()

        const held = (
          proxy as unknown as {
            partitionAccount: {
              postageStamps: { batchID: { toHex(): string } }[]
            }
          }
        ).partitionAccount.postageStamps
        // Exactly the granted drive: the default the app no longer names is
        // dropped with it.
        expect(held.map((s) => s.batchID.toHex())).toEqual([OTHER_BATCH_ID_HEX])
      } finally {
        busChannel.close()
      }
    })

    /** Same shape, one field over: the account default moves. Before the
     *  narrowing the session at least HELD the new default's stamp; now a
     *  pointer that never folds filters it out, so the session goes
     *  upload-dead the moment the old default is tombstoned. */
    it("follows the account default a newer delta moves", async () => {
      const busChannel = await hydratedSession()
      try {
        busChannel.postMessage(
          accountDelta({
            defaultPostageStampBatchID: OTHER_BATCH_ID_HEX,
            defaultStampAt: Date.now() + 1,
            postageStamps: [makeSyncedAccount().postageStamps[0], otherStamp()],
          }),
        )
        await flushBus()

        const held = proxy as unknown as {
          partitionAccount: {
            defaultPostageStampBatchID?: { toHex(): string }
            postageStamps: { batchID: { toHex(): string } }[]
          }
        }
        expect(held.partitionAccount.defaultPostageStampBatchID?.toHex()).toBe(
          OTHER_BATCH_ID_HEX,
        )
        expect(
          held.partitionAccount.postageStamps.map((s) => s.batchID.toHex()),
        ).toContain(OTHER_BATCH_ID_HEX)
      } finally {
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

    /** Seed storage, identify as the dApp, and wait for the bus room — the
     *  unpartitioned session that is the only one able to PUBLISH a delta. */
    async function unpartitionedSession(overrides?: {
      account?: Partial<SyncedAccount>
      connectedApps?: ConnectedApp[]
    }): Promise<BroadcastChannel> {
      seedConnectedAccount(overrides)
      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await awaitBusJoin()
      return new BroadcastChannel(accountChannelName)
    }

    const listen = (
      busChannel: BroadcastChannel,
    ): Record<string, unknown>[] => {
      const published: Record<string, unknown>[] = []
      busChannel.onmessage = (event) =>
        published.push(event.data as Record<string, unknown>)
      return published
    }

    // An account with no drives is a supported connected state (the connect
    // flow completes with zero stamps), and such an account gets no write
    // coordinator either. Gating the delta on a default stamp — a FEED
    // precondition, since that write is what the stamp pays for — left the one
    // account shape whose revokes reach no partitioned session at all.
    it("publishes a delta for an account with no default stamp", async () => {
      const busChannel = await unpartitionedSession({
        account: { defaultPostageStampBatchID: undefined, postageStamps: [] },
      })
      const published = listen(busChannel)
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
        const snapshot = delta!.snapshot as {
          metadata: Record<string, unknown>
        }
        expect(snapshot.metadata.defaultPostageStampBatchID).toBeUndefined()
      } finally {
        busChannel.close()
      }
    })

    // The transports encrypt with the key they were constructed with, and the
    // switch to account B derives its room before detaching A's. A publish
    // landing in that window would drop B's snapshot — stamp signer keys and
    // all — into A's room, readable by A's peers. The feed write has this guard
    // already; the bus one is the path that carries the keys.
    it("does not publish a delta into another account's bus room", async () => {
      const busChannel = await unpartitionedSession()
      const published = listen(busChannel)
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const internals = proxy as unknown as {
        busBoundAccountId: string | undefined
        publishAccountDelta(): void
      }
      try {
        internals.busBoundAccountId = "bb".repeat(20)
        internals.publishAccountDelta()
        await flushBus()

        expect(
          published.filter((m) => m.type === "account-delta"),
        ).toHaveLength(0)
        expect(
          warn.mock.calls.some(([message]) =>
            String(message).includes("bus room"),
          ),
        ).toBe(true)
      } finally {
        busChannel.close()
      }
    })

    // The common revoke: the user removes the app in the SwarmID UI while only
    // this dApp is open. The unpartitioned iframe sees it in storage and
    // disconnects itself — and used to do so silently, so this dApp's own
    // partitioned sessions (the ones that cannot read storage) never heard the
    // revoke that ended them.
    it("publishes a final delta when storage reveals this app revoked", async () => {
      const busChannel = await unpartitionedSession()
      const published = listen(busChannel)
      try {
        seedConnectedAccount({ connectedApps: [revoked(PARENT_ORIGIN)] })
        await (
          proxy as unknown as {
            handleAccountStorageChange(): Promise<void>
          }
        ).handleAccountStorageChange()
        await flushBus()

        expect(messagesOfType("disconnectResponse")).toHaveLength(1)
        const deltas = published.filter((m) => m.type === "account-delta")
        expect(deltas).toHaveLength(1)
        expect(() => BusMessageSchema.parse(deltas[0])).not.toThrow()
        const snapshot = deltas[0].snapshot as {
          connectedApps: Record<string, unknown>[]
        }
        const ours = snapshot.connectedApps.find(
          (app) => app.appUrl === PARENT_ORIGIN,
        )
        expect(ours?.revokedAt).toBeDefined()
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

  /** Seed shared storage with an account already connected to the dApp.
   *  A different `derivationKey` makes it a different account — a different
   *  bus room — while staying connected to the same dApp, which is what an
   *  account switch looks like from in here. */
  // The harm the length check caused: a peer ALREADY in the view, gone stale
  // (`activeDeviceIds` prunes past `KNOWN_DEVICE_MAX_AGE_MS`), is refreshed by
  // the roster — same list length, so the merge was discarded and the peer
  // stayed pruned. It then never gets an intent read, which is the dual-acquire
  // the refresh exists to prevent (#586).
  it("folds a refreshed sign-in for a peer already in the view", async () => {
    const staleSignIn = Date.now() - 2 * KNOWN_DEVICE_MAX_AGE_MS
    const peerId = "peer-device-already-known"
    // Our own device has to be in the list already, or `mergeDevices` adds it
    // and the length changes — which is the one case the old guard did catch.
    const selfId = "self-device-already-known"
    localStorageFake.setItem("swarm-id-device-id", selfId)
    const account = makeSyncedAccount()
    account.devices = [
      { deviceId: selfId, createdAt: staleSignIn, lastSignedInAt: Date.now() },
      { deviceId: peerId, createdAt: staleSignIn, lastSignedInAt: staleSignIn },
    ]

    rosterDevices.length = 0
    rosterDevices.push({
      deviceId: peerId,
      createdAt: staleSignIn,
      lastSignedInAt: Date.now(),
    })

    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(account),
    })

    const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as {
      deps: {
        knownDeviceIds: () => string[]
        refreshKnownDeviceIds: () => Promise<void>
      }
    }
    // Aged out of the rival set, though the account view lists it.
    expect(deps.knownDeviceIds()).not.toContain(peerId)

    await deps.refreshKnownDeviceIds()

    expect(deps.knownDeviceIds()).toContain(peerId)
  })

  // The same fold on the other branch. The guard is deliberately shared, so
  // this is the half that pins `manager.save` — the rival set alone would pass
  // on a merge that reached memory and never reached storage, and then every
  // other context (and the next page load) keeps reading the stale copy.
  it("saves the refreshed registry to shared storage when unpartitioned", async () => {
    const staleSignIn = Date.now() - 2 * KNOWN_DEVICE_MAX_AGE_MS
    const refreshedSignIn = Date.now()
    const peerId = "peer-device-stored"
    const selfId = "self-device-stored"
    localStorageFake.setItem("swarm-id-device-id", selfId)
    const synced = seedConnectedAccount({
      account: {
        devices: [
          {
            deviceId: selfId,
            createdAt: staleSignIn,
            lastSignedInAt: Date.now(),
          },
          {
            deviceId: peerId,
            createdAt: staleSignIn,
            lastSignedInAt: staleSignIn,
          },
        ],
      },
    })

    rosterDevices.length = 0
    rosterDevices.push({
      deviceId: peerId,
      createdAt: staleSignIn,
      lastSignedInAt: refreshedSignIn,
    })

    proxy.destroy()
    mountProxy()
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )

    const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as { deps: { refreshKnownDeviceIds: () => Promise<void> } }
    await deps.refreshKnownDeviceIds()

    const stored = JSON.parse(
      localStorageFake.getItem(STORAGE_KEY_ACCOUNTS)!,
    ) as { data: { id: string; devices: Device[] }[] }
    const savedPeer = stored.data
      .find((a) => a.id === synced.id.toHex())!
      .devices.find((d) => d.deviceId === peerId)
    expect(savedPeer?.lastSignedInAt).toBe(refreshedSignIn)
  })

  // A partition is one (top-level site, iframe origin) pair, so this iframe is
  // a device per dApp — and three connected dApps on one Safari announced three
  // identical "Safari on Mac" rows (#570). The dApp host is what tells them
  // apart. Asserted on the row ALREADY in the registry, because correcting only
  // newly-created rows would leave the existing ones ambiguous until they
  // expire.
  it("names a partition device after the dApp it belongs to", async () => {
    const selfId = "self-device-partitioned"
    localStorageFake.setItem("swarm-id-device-id", selfId)
    const account = makeSyncedAccount()
    account.devices = [
      {
        deviceId: selfId,
        createdAt: Date.now(),
        lastSignedInAt: Date.now(),
        name: "Safari on Mac",
      },
    ]
    // `refreshDeviceRegistryFromSwarm` returns early on an empty roster, so the
    // merge that renames us only runs when there is something to read.
    rosterDevices.length = 0
    rosterDevices.push({
      deviceId: selfId,
      createdAt: Date.now(),
      lastSignedInAt: Date.now(),
      name: "Safari on Mac",
    })

    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(account),
    })

    const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as { deps: { refreshKnownDeviceIds: () => Promise<void> } }
    await deps.refreshKnownDeviceIds()

    const internals = proxy as unknown as {
      partitionAccount: { devices: Device[] }
    }
    const self = internals.partitionAccount.devices.find(
      (d) => d.deviceId === selfId,
    )
    // The browser half is the environment's (`detectDeviceName`, covered with
    // stubbed user agents in `device-id.test.ts`); what this pins is the dApp
    // suffix, and that the row seeded as a bare "Safari on Mac" was corrected.
    expect(self?.name).toMatch(/ · dapp\.example\.com$/)
  })

  // The other half of the same rule, and the reason it is a rule rather than a
  // format: an UNPARTITIONED proxy reads the trusted domain's first-party
  // store, so it shares `swarm-id-device-id` with the identity UI. Naming that
  // device after whichever dApp happened to embed it would relabel the user's
  // browser as a dApp.
  it("leaves an unpartitioned device's name free of the dApp", async () => {
    const selfId = "self-device-shared"
    localStorageFake.setItem("swarm-id-device-id", selfId)
    const synced = seedConnectedAccount({
      account: {
        devices: [
          {
            deviceId: selfId,
            createdAt: Date.now(),
            lastSignedInAt: Date.now(),
            name: "Safari on Mac",
          },
        ],
      },
    })
    rosterDevices.length = 0
    rosterDevices.push({
      deviceId: selfId,
      createdAt: Date.now(),
      lastSignedInAt: Date.now(),
      name: "Safari on Mac",
    })

    proxy.destroy()
    mountProxy()
    await dispatch(
      { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
      PARENT_ORIGIN,
      parentWindow,
    )

    const { deps } = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
      .value as { deps: { refreshKnownDeviceIds: () => Promise<void> } }
    await deps.refreshKnownDeviceIds()

    const stored = JSON.parse(
      localStorageFake.getItem(STORAGE_KEY_ACCOUNTS)!,
    ) as { data: { id: string; devices: Device[] }[] }
    const self = stored.data
      .find((a) => a.id === synced.id.toHex())!
      .devices.find((d) => d.deviceId === selfId)
    expect(self?.name).not.toContain("dapp.example.com")
  })

  // The roster half of #611, and the half that PROPAGATES. `alreadyAnnounced`
  // read a tombstoned self as "not yet announced" and republished us without
  // the tombstone, resurrecting the device on every peer. A removal or an
  // expiry is news to obey, not a gap to fill.
  describe("a device tombstoned in the roster", () => {
    const selfId = "self-device-tombstoned"
    /** Well in the past, so a reactivation's fresh stamp must outrank it. */
    const TOMBSTONED_AT = 2_000_000

    /**
     * Connect partitioned with a stamp, then hand back the publish seam.
     * `handOverTombstoned` makes the popup's payload list this device as
     * removed, which is what `reactivateThisDevice` acts on.
     */
    async function connectAndArm(handOverTombstoned = false): Promise<{
      publish: (reason: "acquired" | "change") => Promise<void>
      withWrite: ReturnType<typeof vi.fn>
    }> {
      localStorageFake.setItem("swarm-id-device-id", selfId)
      const account = makeSyncedAccount()
      if (handOverTombstoned) {
        account.devices = [
          {
            deviceId: selfId,
            createdAt: 1_000_000,
            lastSignedInAt: 1_000_000,
            removedAt: TOMBSTONED_AT,
          },
        ]
      }
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(account),
      })
      const coordinator = vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!
        .value as {
        currentPartition?: number
        accountId?: string
        withWrite: ReturnType<typeof vi.fn>
        deps: { accountId: string }
      }
      // A publish needs a held partition, and it re-checks that the snapshot's
      // account still matches the coordinator's before writing — the mock
      // carries the id on `deps` only, so mirror it where the guard reads it.
      coordinator.currentPartition = 0
      coordinator.accountId = coordinator.deps.accountId
      const internals = proxy as unknown as {
        runAccountStatePublish(reason: "acquired" | "change"): Promise<void>
      }
      return {
        publish: (reason) => internals.runAccountStatePublish(reason),
        withWrite: coordinator.withWrite,
      }
    }

    it("does not re-announce itself into the roster", async () => {
      rosterDevices.length = 0
      rosterDevices.push({
        deviceId: selfId,
        createdAt: Date.now(),
        lastSignedInAt: Date.now(),
        removedAt: Date.now(),
      })

      const { publish, withWrite } = await connectAndArm()
      await publish("acquired")

      expect(withWrite).not.toHaveBeenCalled()
    })

    // The other side of the stand-down: it must not swallow the re-announce a
    // genuine sign-in earns. `reactivateThisDevice` lifts our tombstone on the
    // handover, and the roster only learns of it when we publish — so a guard
    // that keys on the roster entry alone silences the very reactivation it
    // defers to, and the removal never lifts anywhere.
    it("re-announces after a handover lifted its tombstone", async () => {
      rosterDevices.length = 0
      rosterDevices.push({
        deviceId: selfId,
        createdAt: 1_000_000,
        lastSignedInAt: 1_000_000,
        removedAt: TOMBSTONED_AT,
      })

      const { publish, withWrite } = await connectAndArm(true)
      await publish("acquired")

      expect(withWrite).toHaveBeenCalled()
    })

    // The counter-case, so the assertion above is not passing because nothing
    // ever announces: a device the roster does not list still announces.
    it("still announces a device the roster does not list", async () => {
      rosterDevices.length = 0
      rosterDevices.push({
        deviceId: "somebody-else",
        createdAt: Date.now(),
        lastSignedInAt: Date.now(),
      })

      const { publish, withWrite } = await connectAndArm()
      await publish("acquired")

      expect(withWrite).toHaveBeenCalled()
    })
  })

  // #337's rule, at the one seam that can tell a user unlocking their account
  // from a timer firing. `mergeDevices` used to do this on every refresh, which
  // is why no removal stuck (#611). A handover is a real sign-in: the user
  // clicked connect and unlocked in the popup.
  it("lifts this device's tombstone on a fresh handover", async () => {
    const selfId = "self-device-returning"
    const removedAt = 2_000_000
    localStorageFake.setItem("swarm-id-device-id", selfId)
    const account = makeSyncedAccount()
    const tombstone = {
      deviceId: selfId,
      createdAt: 1_000_000,
      lastSignedInAt: 1_000_000,
      removedAt,
    }
    account.devices = [tombstone]

    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(account),
    })

    const internals = proxy as unknown as {
      partitionAccount: { devices: Device[] }
    }
    const self = internals.partitionAccount.devices.find(
      (d) => d.deviceId === selfId,
    )
    expect(self?.removedAt).toBeUndefined()

    // Clearing `removedAt` is only half a reactivation. `mergeDevicesList`
    // ranks on `max(removedAt, lastSignedInAt)`, so a lift that leaves the old
    // sign-in stamp in place loses to the very tombstone it is undoing — the
    // next poll folds the removal straight back in. A handover IS a sign-in, so
    // it must stamp one recent enough to outrank the removal.
    expect(self?.lastSignedInAt).toBeGreaterThan(removedAt)
    expect(mergeDevicesList([self!], [tombstone])).toEqual([self])
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

  // The settings this session runs on came over the handover; the store this
  // event points at is the PARTITION's, which holds none. Re-reading it there
  // loads `undefined` and falls through to the public gateway and the default
  // RPC — silently moving a user on a local or custom Bee node onto neither
  // (#580). The event only fires from another context in this same partition,
  // never from the first-party tab where settings are actually changed.
  it("keeps hydrated network settings when a storage event says they changed", async () => {
    const challenge = await startPartitionedConnect()
    await sendSetSecret(challenge, {
      account: serializeSyncedAccount(makeSyncedAccount()),
      networkSettings: {
        beeNodeUrl: "https://bee.example.test/",
        gnosisRpcUrl: "https://rpc.example.test/",
      },
    })

    storageListener({ key: STORAGE_KEY_NETWORK_SETTINGS } as StorageEvent)

    const internals = proxy as unknown as {
      beeApiUrl: string
      gnosisRpcUrl: string
    }
    // Both, not just the Bee URL: an RPC-only difference is invisible to a
    // `beeNodeUrl` guard, which is the trap `applyNetworkSettingsValues` exists
    // to avoid.
    expect(internals.beeApiUrl).toBe("https://bee.example.test/")
    expect(internals.gnosisRpcUrl).toBe("https://rpc.example.test/")
  })

  // The same hang, one guard down (#678 review). A handover carrying OUR
  // challenge is this attempt's popup answering, so refusing it for the origin
  // it names has to end the attempt too — otherwise the button spins on while
  // the popup says "Connected!", which is the whole point of the fix above.
  // Only reachable through a popup whose origin disagrees with `parentOrigin`
  // — an origin-normalisation drift is the realistic way.
  it("ends the connect attempt when the handover names another origin", async () => {
    const challenge = await startPartitionedConnect()
    const internals = proxy as unknown as { isConnecting: boolean }
    // What `handleLoginClick` does when the button is the one connecting.
    internals.isConnecting = true

    await dispatch(
      {
        type: "setSecret",
        appOrigin: "https://not-our-parent.example.com",
        challenge,
        data: {
          secret: "33".repeat(32),
          account: serializeSyncedAccount(makeSyncedAccount()),
        },
      },
      ID_ORIGIN,
    )

    expect(messagesOfType("authSuccess")).toHaveLength(0)
    expect(internals.isConnecting).toBe(false)
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
  // Liveness rides the bus (docs/Account-Bus.md, presence): a device beating
  // in the room is alive by construction, so the rival set reads it instead of
  // a stored timestamp nothing refreshes.
  describe("presence", () => {
    const ACCOUNT_ID = "aa".repeat(20)

    type Deps = { deps: { knownDeviceIds: () => string[] } }
    const knownDeviceIds = () =>
      (
        vi.mocked(BatchWriteCoordinator).mock.results.at(-1)!.value as Deps
      ).deps.knownDeviceIds()

    async function connect(): Promise<void> {
      const challenge = await startPartitionedConnect()
      await sendSetSecret(challenge, {
        account: serializeSyncedAccount(makeSyncedAccount()),
      })
      await awaitBusJoin()
    }

    /** Every beat this proxy publishes on the bus, in order. */
    function recordBeats(channel: BroadcastChannel): { type: string }[] {
      const seen: { type: string }[] = []
      channel.addEventListener("message", (event) => {
        const message = (event as MessageEvent).data as { type: string }
        if (message.type === "presence") seen.push(message)
      })
      return seen
    }

    it("announces this device on joining the room, and every interval", async () => {
      // Only the interval is faked: BroadcastChannel delivery and `flushBus`
      // ride the real event loop.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
      const busChannel = new BroadcastChannel(accountChannelName)
      const beats = recordBeats(busChannel)
      try {
        await connect()
        await flushBus()
        expect(beats).toHaveLength(1)
        const beat = BusMessageSchema.parse(beats[0])
        expect(beat).toEqual({
          type: "presence",
          accountId: ACCOUNT_ID,
          fromDeviceId: localStorageFake.getItem("swarm-id-device-id"),
        })

        vi.advanceTimersByTime(PRESENCE_INTERVAL_MS)
        await flushBus()
        expect(beats).toHaveLength(2)

        proxy.destroy()
        vi.advanceTimersByTime(PRESENCE_INTERVAL_MS)
        await flushBus()
        expect(beats).toHaveLength(2)
      } finally {
        vi.useRealTimers()
        busChannel.close()
      }
    })

    it("counts a beating peer as a rival until its beats stop", async () => {
      const busChannel = new BroadcastChannel(accountChannelName)
      try {
        await connect()
        expect(knownDeviceIds()).not.toContain("peer-live")

        busChannel.postMessage({
          type: "presence",
          accountId: ACCOUNT_ID,
          fromDeviceId: "peer-live",
        })
        // Not rivals: a beat for another account's room, and this device's
        // own id from a sibling tab.
        busChannel.postMessage({
          type: "presence",
          accountId: "bb".repeat(20),
          fromDeviceId: "peer-elsewhere",
        })
        busChannel.postMessage({
          type: "presence",
          accountId: ACCOUNT_ID,
          fromDeviceId: localStorageFake.getItem("swarm-id-device-id"),
        })
        await flushBus()

        const rivals = knownDeviceIds()
        expect(rivals).toContain("peer-live")
        expect(rivals).not.toContain("peer-elsewhere")
        expect(rivals).not.toContain(
          localStorageFake.getItem("swarm-id-device-id"),
        )

        // Only the clock moves; timers and channel delivery stay real.
        const later = Date.now() + PRESENCE_MAX_AGE_MS + 1
        vi.spyOn(Date, "now").mockReturnValue(later)
        expect(knownDeviceIds()).not.toContain("peer-live")
      } finally {
        vi.restoreAllMocks()
        busChannel.close()
      }
    })

    // Ageing is the backstop, not the mechanism: a closed tab would otherwise
    // stay a rival for PRESENCE_MAX_AGE_MS, costing every acquire in that
    // window an absent intent read. The room says who left — the signaling
    // server sends `peer-left` on socket close, and its reaper sends it for a
    // crash too — which is the only departure signal a dying page can produce,
    // since a leave published on unload never finishes encrypting (#572).
    it("drops a peer from the rival set when the room says it left", async () => {
      proxy.destroy()
      signalingRoom.deliver.length = 0
      signalingRoom.peerLeft.length = 0
      mountProxy({ signalingUrl: "ws://signaling.test" })
      await connect()

      await vi.waitFor(() => expect(signalingRoom.deliver).not.toHaveLength(0))
      for (const deliver of signalingRoom.deliver) {
        deliver(
          {
            type: "presence",
            accountId: ACCOUNT_ID,
            fromDeviceId: "peer-live",
          },
          "socket-1",
        )
      }
      expect(knownDeviceIds()).toContain("peer-live")

      for (const left of signalingRoom.peerLeft) left("socket-1")
      expect(knownDeviceIds()).not.toContain("peer-live")
    })

    // A rival set is per account, so a switch must FORGET the old room's live
    // peers, not just stop hearing them: they are another account's devices,
    // and nothing would ever age them out of a tracker that survives the
    // switch. `destroy` clears the same tracker; this is the other caller.
    it("forgets the previous room's live peers on a switch", async () => {
      seedConnectedAccount()
      await dispatch(
        { type: "parentIdentify", requestId: "r1", metadata: { name: "dApp" } },
        PARENT_ORIGIN,
        parentWindow,
      )
      await awaitBusJoin()
      const first = busTopicNow()

      const previous = new BroadcastChannel(accountChannelName)
      try {
        previous.postMessage({
          type: "presence",
          accountId: ACCOUNT_ID,
          fromDeviceId: "peer-live",
        })
        await flushBus()
        expect(knownDeviceIds()).toContain("peer-live")

        seedConnectedAccount({
          account: { derivationKey: OTHER_DERIVATION_KEY },
        })
        rejoinBus()
        await vi.waitFor(() => expect(busTopicNow()).not.toBe(first))

        expect(knownDeviceIds()).not.toContain("peer-live")
      } finally {
        previous.close()
      }
    })
  })

  describe("account-bus signaling transport", () => {
    const SIGNALING_URL = "ws://signaling.test"

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

      const switched = seedConnectedAccount({
        account: { derivationKey: OTHER_DERIVATION_KEY },
      })
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

      seedConnectedAccount({ account: { derivationKey: OTHER_DERIVATION_KEY } })
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
