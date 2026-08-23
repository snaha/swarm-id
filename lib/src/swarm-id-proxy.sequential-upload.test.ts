// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Characterization of the three sequential-feed upload handlers, driven through
 * the proxy's postMessage layer.
 *
 * The three share almost all of their body — index resolution, timestamp
 * prefixing, payload bounds, identifier derivation, SOC upload — and differ only
 * in what they encode into the payload, which encryption key they hand to
 * `uploadSOC`, and the response they post back. These tests pin both halves: the
 * shared wire behaviour and each handler's specific differences.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

import { SwarmIdProxy } from "./swarm-id-proxy"
import { decryptChunkData } from "./chunk"
import { hexToUint8Array, uint8ArrayToHex } from "./utils/hex"

const PARENT_ORIGIN = "https://dapp.example.com"
const GATEWAY_URL = "https://gateway.example"

const APP_SECRET_HEX =
  "634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd"
const OWNER_HEX = "8d3766440f0d7b949a5e32995d09619a7f86e632"
const TOPIC_HEX =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
const REFERENCE_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
const ENCRYPTION_KEY_HEX =
  "0f0e0d0c0b0a09080706050403020100000102030405060708090a0b0c0d0e0f"

/** SOC addresses of the (TOPIC_HEX, index, OWNER_HEX) sequential feed entries. */
const SEQ_ADDRESS_INDEX_0 =
  "4e8ce27730e7627748330c4c12eb95cf77f559c2e34fcc0dff68ad7ad2ce2b23"
const SEQ_ADDRESS_INDEX_3 =
  "7680f28e4e029b4764faf77e736333ba3827c9c24e950e4ef3efb22181349bde"

const OTHER_SIGNER_HEX =
  "1111111111111111111111111111111111111111111111111111111111111111"
const OTHER_OWNER_HEX = "19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"
const OTHER_SEQ_ADDRESS_INDEX_3 =
  "2dfc7c02cafea4300e51557bd17339f739a82d06f3bb839d1fb0b497e86b40c1"

const SPAN_BYTES = 8
const ENCRYPTION_KEY_HEX_LEN = 64
const AT = 1700000000
/** `AT` as the 8-byte big-endian prefix the handlers prepend to the payload. */
const TIMESTAMP_AT_HEX = "000000006553f100"

type MessageListener = (event: MessageEvent) => Promise<void>
type ProxyMessage = { type: string; requestId?: string } & Record<
  string,
  unknown
>

describe("sequential feed upload handlers", () => {
  let parentWindow: { postMessage: ReturnType<typeof vi.fn> }
  let messageListener: MessageListener
  let socUploads: Array<{ url: string; body: Uint8Array }>

  /** Payload of an uploaded SOC body, decrypting first when a key was used. */
  const uploadedPayload = (index: number, keyHex?: unknown): Uint8Array => {
    const body = socUploads[index].body
    const chunk =
      typeof keyHex === "string"
        ? decryptChunkData(hexToUint8Array(keyHex), body)
        : body
    const span = new DataView(
      chunk.buffer,
      chunk.byteOffset,
      SPAN_BYTES,
    ).getBigUint64(0, true)
    return chunk.slice(SPAN_BYTES, SPAN_BYTES + Number(span))
  }

  const dispatch = (data: unknown) =>
    messageListener({
      data,
      origin: PARENT_ORIGIN,
      source: parentWindow,
    } as MessageEvent)

  const responses = (): ProxyMessage[] =>
    parentWindow.postMessage.mock.calls.map(([message]) => message)

  const responseFor = (requestId: string): ProxyMessage => {
    const match = responses().find((message) => message.requestId === requestId)
    if (!match) throw new Error(`no response for ${requestId}`)
    return match
  }

  beforeEach(async () => {
    vi.restoreAllMocks()
    socUploads = []

    parentWindow = { postMessage: vi.fn() }
    const listeners: Record<string, unknown> = {}
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      parent: parentWindow,
      location: { origin: "https://id.example.com" },
    })
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      socUploads.push({ url, body: init?.body as Uint8Array })
      return new Response(JSON.stringify({ reference: "" }), { status: 200 })
    })

    const proxy = new SwarmIdProxy()
    messageListener = listeners["message"] as MessageListener

    await dispatch({
      type: "parentIdentify",
      requestId: "identify",
      metadata: { name: "Test App" },
      subsidisedGatewayUrl: GATEWAY_URL,
    })

    // No postage batch + a subsidised gateway puts uploads on the gateway path,
    // so the handlers run without a stamper.
    const state = proxy as unknown as {
      authenticated: boolean
      appSecret: string
      bee: { downloadChunk: (reference: string) => Promise<Uint8Array> }
    }
    state.authenticated = true
    state.appSecret = APP_SECRET_HEX
    // Empty feed: every index lookup misses.
    state.bee = {
      downloadChunk: async () => {
        throw new Error("chunk not found")
      },
    }
    parentWindow.postMessage.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("shared behaviour", () => {
    it("uploads at the requested index and reports it back", async () => {
      await dispatch({
        type: "seqFeedUploadPayload",
        requestId: "r1",
        topic: TOPIC_HEX,
        data: new Uint8Array([1, 2, 3]),
        index: 3,
        at: AT,
      })

      expect(responseFor("r1")).toMatchObject({
        reference: SEQ_ADDRESS_INDEX_3,
        feedIndex: "3",
        owner: OWNER_HEX,
      })
      expect(
        socUploads[0].url.startsWith(`${GATEWAY_URL}/soc/${OWNER_HEX}/`),
      ).toBe(true)
    })

    it("falls back to index 0 on an empty feed", async () => {
      await dispatch({
        type: "seqFeedUploadRawPayload",
        requestId: "r2",
        topic: TOPIC_HEX,
        data: new Uint8Array([1, 2, 3]),
        at: AT,
      })

      expect(responseFor("r2")).toMatchObject({
        reference: SEQ_ADDRESS_INDEX_0,
        feedIndex: "0",
      })
    })

    it("prefixes a big-endian timestamp unless hasTimestamp is false", async () => {
      const data = new Uint8Array([1, 2, 3, 4])

      await dispatch({
        type: "seqFeedUploadRawPayload",
        requestId: "r3",
        topic: TOPIC_HEX,
        data,
        index: 3,
        at: AT,
      })
      await dispatch({
        type: "seqFeedUploadRawPayload",
        requestId: "r4",
        topic: TOPIC_HEX,
        data,
        index: 3,
        at: AT,
        hasTimestamp: false,
      })

      expect(uint8ArrayToHex(uploadedPayload(0))).toBe(
        `${TIMESTAMP_AT_HEX}01020304`,
      )
      expect(uint8ArrayToHex(uploadedPayload(1))).toBe("01020304")
    })

    it("rejects a payload that exceeds the chunk size once prefixed", async () => {
      await dispatch({
        type: "seqFeedUploadPayload",
        requestId: "r5",
        topic: TOPIC_HEX,
        data: new Uint8Array(4096),
        index: 3,
        at: AT,
      })

      expect(responseFor("r5")).toMatchObject({
        type: "error",
        error: "Invalid payload length: 4104 (expected 1-4096)",
      })
      expect(socUploads).toHaveLength(0)
    })

    it("owns the entry with the supplied signer instead of the app secret", async () => {
      await dispatch({
        type: "seqFeedUploadReference",
        requestId: "r6",
        topic: TOPIC_HEX,
        reference: REFERENCE_HEX,
        index: 3,
        at: AT,
        signer: OTHER_SIGNER_HEX,
      })

      expect(responseFor("r6")).toMatchObject({
        owner: OTHER_OWNER_HEX,
        reference: OTHER_SEQ_ADDRESS_INDEX_3,
      })
    })
  })

  describe("seqFeedUploadPayload", () => {
    it("encrypts by default and returns the generated key", async () => {
      await dispatch({
        type: "seqFeedUploadPayload",
        requestId: "p1",
        topic: TOPIC_HEX,
        data: new Uint8Array([1, 2, 3]),
        index: 3,
        at: AT,
      })

      const response = responseFor("p1")
      expect(response.type).toBe("seqFeedUploadPayloadResponse")
      expect(response.encryptionKey).toHaveLength(ENCRYPTION_KEY_HEX_LEN)
      expect(response.tagUid).toBeUndefined()
      expect(uint8ArrayToHex(uploadedPayload(0, response.encryptionKey))).toBe(
        `${TIMESTAMP_AT_HEX}010203`,
      )
    })

    it("uploads a plain SOC when options.encrypt is false", async () => {
      await dispatch({
        type: "seqFeedUploadPayload",
        requestId: "p2",
        topic: TOPIC_HEX,
        data: new Uint8Array([1, 2, 3]),
        index: 3,
        at: AT,
        options: { encrypt: false },
      })

      expect(responseFor("p2").encryptionKey).toBeUndefined()
    })
  })

  describe("seqFeedUploadRawPayload", () => {
    it("uploads a plain SOC and returns no key when none is given", async () => {
      await dispatch({
        type: "seqFeedUploadRawPayload",
        requestId: "w1",
        topic: TOPIC_HEX,
        data: new Uint8Array([1, 2, 3]),
        index: 3,
        at: AT,
      })

      const response = responseFor("w1")
      expect(response.type).toBe("seqFeedUploadRawPayloadResponse")
      expect(response.encryptionKey).toBeUndefined()
    })

    it("echoes the caller's encryption key back verbatim", async () => {
      await dispatch({
        type: "seqFeedUploadRawPayload",
        requestId: "w2",
        topic: TOPIC_HEX,
        data: new Uint8Array([1, 2, 3]),
        index: 3,
        at: AT,
        encryptionKey: ENCRYPTION_KEY_HEX,
      })

      expect(responseFor("w2").encryptionKey).toBe(ENCRYPTION_KEY_HEX)
    })
  })

  describe("seqFeedUploadReference", () => {
    it("uploads the decoded reference bytes, always encrypted", async () => {
      await dispatch({
        type: "seqFeedUploadReference",
        requestId: "f1",
        topic: TOPIC_HEX,
        reference: REFERENCE_HEX,
        index: 3,
        at: AT,
      })

      const response = responseFor("f1")
      expect(response.type).toBe("seqFeedUploadReferenceResponse")
      expect(response.reference).toBe(SEQ_ADDRESS_INDEX_3)
      expect(response.encryptionKey).toHaveLength(ENCRYPTION_KEY_HEX_LEN)
      expect(uint8ArrayToHex(uploadedPayload(0, response.encryptionKey))).toBe(
        `${TIMESTAMP_AT_HEX}${REFERENCE_HEX}`,
      )
    })

    it("ignores options.encrypt: false", async () => {
      await dispatch({
        type: "seqFeedUploadReference",
        requestId: "f2",
        topic: TOPIC_HEX,
        reference: REFERENCE_HEX,
        index: 3,
        at: AT,
        options: { encrypt: false },
      })

      expect(responseFor("f2").encryptionKey).toHaveLength(
        ENCRYPTION_KEY_HEX_LEN,
      )
    })
  })
})
