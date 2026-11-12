// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What each upload mode forwards to Bee.
 *
 * The subsidised path never sends `Swarm-Pin` (#752): pinning means "keep
 * this on the local node", and the node is the dApp operator's, not the
 * user's — gateway-proxy strips the header by default, and the public
 * gateway's CORS preflight rejects it outright, as a bare "Failed to fetch".
 *
 * Stamper mode still sends it — the node is the user's own — so the positive
 * half is asserted too, or a header dropped from the wrong branch stays green.
 * Stamper mode also honours the caller's `deferred` on every data and chunk upload (#784).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { Bee, PrivateKey, Identifier } from "@ethersphere/bee-js"
import { uploadChunk, uploadData, uploadSOC, type UploadTarget } from "./upload"
import { MockBee, createMockStamper } from "./feeds/epochs/test-utils"

const GATEWAY = "https://gateway.example"
const TARGET: UploadTarget = { mode: "subsidised", gatewayUrl: GATEWAY }
const REFERENCE = "ab".repeat(32)
const TAG_UID = 7

const signer = new PrivateKey(new Uint8Array(32).fill(1))
const identifier = new Identifier(new Uint8Array(32))

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ reference: REFERENCE })),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

/** Header names of every request the stub saw, lowercased so a casing
 *  change in the code cannot make a `not.toContain` pass vacuously. */
function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.flatMap(([, init]) =>
    Object.keys((init as RequestInit).headers as Record<string, string>).map(
      (name) => name.toLowerCase(),
    ),
  )
}

function stamperTarget(bee: Bee): UploadTarget {
  return { mode: "stamper", bee, stamper: createMockStamper() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("subsidised uploads omit swarm-pin", () => {
  it("on a chunk", async () => {
    const fetchMock = stubFetch()
    await uploadChunk(TARGET, new Uint8Array(16), { pin: true })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("on data", async () => {
    const fetchMock = stubFetch()
    await uploadData(TARGET, new Uint8Array(16), { pin: true })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("on a SOC", async () => {
    const fetchMock = stubFetch()
    await uploadSOC(TARGET, signer, identifier, new Uint8Array(16), {
      pin: true,
    })
    expect(fetchMock).toHaveBeenCalled()
    expect(sentHeaders(fetchMock)).not.toContain("swarm-pin")
  })

  it("still forward deferred, which every gateway accepts", async () => {
    const fetchMock = stubFetch()
    await uploadChunk(TARGET, new Uint8Array(16), { deferred: true })
    await uploadData(TARGET, new Uint8Array(16), { deferred: true })
    await uploadSOC(TARGET, signer, identifier, new Uint8Array(16), {
      deferred: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      sentHeaders(fetchMock).filter((name) => name === "swarm-deferred-upload"),
    ).toHaveLength(3)
  })
})

describe("stamper uploads keep swarm-pin", () => {
  it("on a SOC", async () => {
    const fetchMock = stubFetch()
    const target = stamperTarget(new MockBee())
    await uploadSOC(target, signer, identifier, new Uint8Array(16), {
      pin: true,
      tag: TAG_UID,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ "swarm-pin": "true" })
  })

  it("on a chunk, through bee.chunk.upload's options", async () => {
    const bee = new MockBee()
    const chunkUpload = vi.fn(bee.chunk.upload)
    bee.chunk.upload = chunkUpload

    await uploadChunk(stamperTarget(bee), new Uint8Array(16), { pin: true })

    expect(chunkUpload).toHaveBeenCalledTimes(1)
    const [, , options] = chunkUpload.mock.calls[0]
    expect(options).toMatchObject({ pin: true })
  })
})

describe("an aborted signal stops the write", () => {
  const CHUNK_PAYLOAD_SIZE = 4096
  const THREE_LEAVES = CHUNK_PAYLOAD_SIZE * 3

  function spiedStamper(signal: AbortSignal): {
    target: UploadTarget
    stamp: ReturnType<typeof vi.fn>
  } {
    const stamper = createMockStamper()
    const stamp = vi.fn(stamper.stamp.bind(stamper))
    stamper.stamp = stamp
    return {
      target: { mode: "stamper", bee: new MockBee(), stamper, signal },
      stamp,
    }
  }

  const rejectionOf = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error("expected a rejection, but it resolved")
      },
      (error: unknown) => error,
    )

  it.each([
    { kind: "plain", encryptionKey: undefined },
    { kind: "encrypted", encryptionKey: true as const },
  ])("stamps nothing for $kind data", async ({ encryptionKey }) => {
    const { target, stamp } = spiedStamper(AbortSignal.abort())

    const error = await rejectionOf(
      uploadData(target, new Uint8Array(THREE_LEAVES), { encryptionKey }),
    )

    expect(error).toMatchObject({ code: "aborted" })
    expect(stamp).not.toHaveBeenCalled()
  })

  it("stops stamping at the abort, part way through", async () => {
    const controller = new AbortController()
    const { target, stamp } = spiedStamper(controller.signal)

    const error = await rejectionOf(
      uploadData(target, new Uint8Array(THREE_LEAVES), {
        onProgress: () => controller.abort(),
      }),
    )

    expect(error).toMatchObject({ code: "aborted" })
    expect(stamp).toHaveBeenCalledTimes(1)
  })

  it("stamps no SOC", async () => {
    const fetchMock = stubFetch()
    const { target, stamp } = spiedStamper(AbortSignal.abort())

    const error = await rejectionOf(
      uploadSOC(target, signer, identifier, new Uint8Array(16), {
        tag: TAG_UID,
      }),
    )

    expect(error).toMatchObject({ code: "aborted" })
    expect(stamp).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      write: "chunk",
      run: (target: UploadTarget) => uploadChunk(target, new Uint8Array(16)),
    },
    {
      write: "data",
      run: (target: UploadTarget) => uploadData(target, new Uint8Array(16)),
    },
    {
      write: "SOC",
      run: (target: UploadTarget) =>
        uploadSOC(target, signer, identifier, new Uint8Array(16)),
    },
  ])("hands the gateway's $write fetch the signal", async ({ run }) => {
    const fetchMock = stubFetch()
    const { signal } = new AbortController()

    await run({ ...TARGET, signal })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(signal)
  })

  it("hands the stamped SOC's fetch the signal", async () => {
    const fetchMock = stubFetch()
    const { signal } = new AbortController()

    await uploadSOC(
      spiedStamper(signal).target,
      signer,
      identifier,
      new Uint8Array(16),
      { tag: TAG_UID },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(signal)
  })

  it.each([
    {
      write: "chunk",
      run: (target: UploadTarget, requestOptions: { timeout: number }) =>
        uploadChunk(target, new Uint8Array(16), { requestOptions }),
    },
    {
      write: "data",
      run: (target: UploadTarget, requestOptions: { timeout: number }) =>
        uploadData(target, new Uint8Array(16), { requestOptions }),
    },
    {
      write: "encrypted data",
      run: (target: UploadTarget, requestOptions: { timeout: number }) =>
        uploadData(target, new Uint8Array(16), {
          encryptionKey: true,
          requestOptions,
        }),
    },
  ])("adds the signal to the Bee options of a $write", async ({ run }) => {
    const timeout = 1234
    const bee = new MockBee()
    const chunkUpload = vi.fn(bee.chunk.upload)
    bee.chunk.upload = chunkUpload
    const { signal } = new AbortController()

    await run({ ...spiedStamper(signal).target, bee } as UploadTarget, {
      timeout,
    })

    const [, , , requestOptions] = chunkUpload.mock.calls[0]
    expect(requestOptions).toEqual({ timeout, signal })
  })
})

/**
 * Stamper mode honours `deferred` (#780 adjacent): a dev-mode Bee serves only
 * deferred uploads, and the documented remedy is to set the flag from
 * `getNodeInfo()`. Forcing `deferred: false` would silently drop the caller's
 * `true` and the upload would time out anyway (#298).
 */
describe("stamper uploads honour deferred", () => {
  function spiedBee(): { bee: MockBee; chunkUpload: ReturnType<typeof vi.fn> } {
    const bee = new MockBee()
    const chunkUpload = vi.fn(bee.chunk.upload)
    bee.chunk.upload = chunkUpload
    return { bee, chunkUpload }
  }

  it("on a chunk", async () => {
    const { bee, chunkUpload } = spiedBee()
    await uploadChunk(stamperTarget(bee), new Uint8Array(16), {
      deferred: true,
    })
    const [, , options] = chunkUpload.mock.calls[0]
    expect(options).toMatchObject({ deferred: true })
  })

  it("on plain data", async () => {
    const { bee, chunkUpload } = spiedBee()
    await uploadData(stamperTarget(bee), new Uint8Array(16), {
      deferred: true,
    })
    const [, , options] = chunkUpload.mock.calls[0]
    expect(options).toMatchObject({ deferred: true })
  })

  it("on encrypted data", async () => {
    const { bee, chunkUpload } = spiedBee()
    await uploadData(stamperTarget(bee), new Uint8Array(16), {
      deferred: true,
      encryptionKey: true,
    })
    const [, , options] = chunkUpload.mock.calls[0]
    expect(options).toMatchObject({ deferred: true })
  })

  it("still defaults to direct", async () => {
    const { bee, chunkUpload } = spiedBee()
    await uploadChunk(stamperTarget(bee), new Uint8Array(16))
    await uploadData(stamperTarget(bee), new Uint8Array(16))
    for (const [, , options] of chunkUpload.mock.calls) {
      expect(options).toMatchObject({ deferred: false })
    }
  })
})

/**
 * The stamper-mode SOC POST is a hand-rolled `fetch`, so it must carry the
 * headers `bee.chunk.upload` would: the `Bee` instance's own and the call's
 * `requestOptions` (#819). Without them an authenticated node answers 401,
 * which the batch-attach probe then misreads as "stampable".
 */
/**
 * A SOC is the one chunk that gets overwritten at its address. Bee replaces it
 * only on a direct push; from 2.8.1 a `Swarm-Tag` on `/soc` makes the upload
 * deferred, and a deferred overwrite reaches no node.
 */
describe("stamper SOC uploads are direct", () => {
  it("unless the caller asks for a deferred one", async () => {
    const fetchMock = stubFetch()
    const target = stamperTarget(new MockBee())
    await uploadSOC(target, signer, identifier, new Uint8Array(16), {
      tag: TAG_UID,
    })
    await uploadSOC(target, signer, identifier, new Uint8Array(16), {
      tag: TAG_UID,
      deferred: true,
    })
    const sent = fetchMock.mock.calls.map(
      ([, init]) =>
        ((init as RequestInit).headers as Record<string, string>)[
          "swarm-deferred-upload"
        ],
    )
    expect(sent).toEqual(["false", "true"])
  })
})

describe("stamper SOC uploads send the Bee headers", () => {
  const AUTH = { authorization: "Bearer node-token" }
  const CALL = { "x-call": "per-call" }

  it("from the Bee instance", async () => {
    const fetchMock = stubFetch()
    const bee = new Bee("http://localhost:1633", { headers: AUTH })
    await uploadSOC(
      stamperTarget(bee),
      signer,
      identifier,
      new Uint8Array(16),
      {
        tag: TAG_UID,
      },
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject(AUTH)
  })

  it("from the call's requestOptions, over the instance's", async () => {
    const fetchMock = stubFetch()
    const bee = new Bee("http://localhost:1633", { headers: AUTH })
    const controller = new AbortController()
    await uploadSOC(
      stamperTarget(bee),
      signer,
      identifier,
      new Uint8Array(16),
      {
        tag: TAG_UID,
        requestOptions: {
          signal: controller.signal,
          headers: { ...CALL, authorization: "Bearer other" },
        },
      },
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      ...CALL,
      authorization: "Bearer other",
      "swarm-tag": String(TAG_UID),
    })
    expect(init.signal).toBe(controller.signal)
  })
})
