// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-partitioning write enablement (docs/Account-Bus.md, phase 3): a
 * `setSecret` popup payload carrying the synced-account projection hydrates
 * the proxy into a first-class writer; the legacy secret-only payload stays
 * download-only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

// Stub the stamper/store/coordinator machinery so `initializeStamper` can run
// without IndexedDB or network access.
vi.mock("./utils/batch-utilization", async (importActual) => {
  const actual =
    await importActual<typeof import("./utils/batch-utilization")>()
  return {
    ...actual,
    UtilizationAwareStamper: {
      create: vi.fn((_signerKey: string, batchId: unknown) =>
        Promise.resolve({ mock: "stamper", batchId }),
      ),
    },
  }
})
vi.mock("./storage/utilization-store", () => ({
  UtilizationStoreDB: vi.fn(function () {
    return {}
  }),
}))
vi.mock("./sync/batch-write-coordinator", () => ({
  BatchWriteCoordinator: vi.fn(function (deps: unknown) {
    return {
      deps,
      startLease: vi.fn(),
      teardown: vi.fn(),
      withWrite: vi.fn(),
      currentPartition: undefined,
    }
  }),
}))

import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"

import { SwarmIdProxy } from "./swarm-id-proxy"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { serializeSyncedAccount } from "./utils/storage-managers"
import { STORAGE_CHALLENGE_KEY } from "./types"
import type { SyncedAccount } from "./schemas"

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

  beforeEach(() => {
    vi.restoreAllMocks()

    parentWindow = { postMessage: vi.fn() }
    localStorageFake = makeLocalStorage()

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

    new SwarmIdProxy()
    messageListener = listeners["message"] as MessageListener
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

  it("rejects a hydration payload with a wrong challenge", async () => {
    const account = makeSyncedAccount()
    await startPartitionedConnect()
    await sendSetSecret("not-the-challenge", {
      account: serializeSyncedAccount(account),
    })

    expect(messagesOfType("authSuccess")).toHaveLength(0)
  })
})
