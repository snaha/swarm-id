// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the client's feed readers and writers post and return, method by
 * method: the epoch and sequential reader/writer pairs, with an iframe that
 * answers every request. Pinned so the four builders can share code without
 * a message changing underneath a dApp.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PrivateKey } from "@ethersphere/bee-js"
import { SwarmIdClient } from "./swarm-id-client"
import type { IframeToParentMessage } from "./types"

type ClientInternals = {
  ready: boolean
  iframe: unknown
  handleIframeMessage: (message: IframeToParentMessage) => void
}

type Message = Record<string, unknown> & { type: string; requestId: string }
type Answer = (message: Message) => Record<string, unknown>

const TOPIC = "12".repeat(32)
const OWNER = "a1".repeat(20)
const PROXY_OWNER = "b2".repeat(20)
const WRITER_OWNER = "c3".repeat(20)
const SIGNER = new PrivateKey("11".repeat(32))
const SIGNER_OWNER = SIGNER.publicKey().address().toHex()
const REF = "ab".repeat(32)
const ENCRYPTED_REF = "cd".repeat(64)
const KEY = "ef".repeat(32)
const SOC_ADDRESS = "5c".repeat(32)
const BATCH = "ba".repeat(32)
const OTHER_BATCH = "bb".repeat(32)
const NOW_MS = 1_700_000_000_000
const NOW_S = "1700000000"
const AT = 1_600_000_000n
const AFTER = 1_500_000_000n
const LOOKUP_TIMEOUT_MS = 1234
const INDEX = 3n
const DATA = new Uint8Array([1, 2, 3])
const PAYLOAD = new Uint8Array([9, 9])
const HINTS = { lastEpoch: { start: "0", level: 32 }, lastTimestamp: "1" }
const TAG_UID = 7

const DEFAULT_ANSWERS: Record<string, Answer> = {
  feedGetOwner: () => ({ owner: PROXY_OWNER }),
  seqFeedGetOwner: () => ({ owner: PROXY_OWNER }),
  epochFeedDownloadReference: () => ({ reference: ENCRYPTED_REF }),
  downloadData: () => ({ data: PAYLOAD }),
  uploadData: () => ({ reference: ENCRYPTED_REF }),
  epochFeedUploadReference: () => ({
    socAddress: SOC_ADDRESS,
    epoch: { start: NOW_S, level: 0 },
    timestamp: NOW_S,
  }),
  seqFeedDownloadPayload: () => seqPayloadAnswer(),
  seqFeedDownloadRawPayload: () => seqPayloadAnswer(),
  seqFeedDownloadReference: () => ({
    reference: REF,
    feedIndex: "3",
    feedIndexNext: "4",
  }),
  seqFeedUploadPayload: () => seqUploadAnswer(),
  seqFeedUploadRawPayload: () => seqUploadAnswer(),
  seqFeedUploadReference: () => seqUploadAnswer(),
}

function seqPayloadAnswer() {
  return { payload: PAYLOAD, timestamp: 5, feedIndex: "3", feedIndexNext: "4" }
}

function seqUploadAnswer() {
  return {
    reference: REF,
    feedIndex: "3",
    owner: WRITER_OWNER,
    encryptionKey: KEY,
    tagUid: TAG_UID,
  }
}

describe("SwarmIdClient feed readers and writers", () => {
  let client: SwarmIdClient
  let posted: Message[]
  let answers: Record<string, Answer>

  /** Every message posted so far, without its request id. */
  const sent = () => posted.map(({ requestId: _, ...rest }) => rest)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW_MS)
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn(),
    })
    vi.stubGlobal("document", {
      createElement: vi.fn(),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    })

    client = new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: { name: "Test App", description: "A test application" },
    })
    posted = []
    answers = { ...DEFAULT_ANSWERS }
    const internals = client as unknown as ClientInternals
    internals.ready = true
    internals.iframe = {
      style: {},
      contentWindow: {
        postMessage: (message: Message) => {
          posted.push(message)
          const answer = answers[message.type]
          if (!answer) return
          queueMicrotask(() =>
            internals.handleIframeMessage({
              type: `${message.type}Response`,
              requestId: message.requestId,
              ...answer(message),
            } as IframeToParentMessage),
          )
        },
      },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe("epoch reader", () => {
    it("knows a given owner without asking", async () => {
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      expect(await reader.getOwner()).toBe(OWNER)
      expect(sent()).toEqual([])
    })

    it("asks the proxy for the owner once, and reads with it after", async () => {
      const reader = client.makeEpochFeedReader({ topic: TOPIC })
      expect(await reader.getOwner()).toBe(PROXY_OWNER)
      expect(await reader.getOwner()).toBe(PROXY_OWNER)
      await reader.downloadRawReference({ at: AT })
      expect(sent()).toEqual([
        { type: "feedGetOwner" },
        {
          type: "epochFeedDownloadReference",
          topic: TOPIC,
          owner: PROXY_OWNER,
          at: AT.toString(),
        },
      ])
    })

    it("downloads a reference, splitting off its key", async () => {
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      const result = await reader.downloadReference({
        at: AT,
        after: AFTER,
        encryptionKey: KEY,
      })
      expect(result).toEqual({
        reference: ENCRYPTED_REF,
        encryptionKey: ENCRYPTED_REF.slice(64),
      })
      expect(sent()).toEqual([
        {
          type: "epochFeedDownloadReference",
          topic: TOPIC,
          owner: OWNER,
          at: AT.toString(),
          after: AFTER.toString(),
          encryptionKey: KEY,
        },
      ])
    })

    it("reads as of now without an `at`", async () => {
      answers.epochFeedDownloadReference = () => ({ reference: REF })
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      expect(await reader.downloadReference()).toEqual({
        reference: REF,
        encryptionKey: undefined,
      })
      expect(sent()).toEqual([
        {
          type: "epochFeedDownloadReference",
          topic: TOPIC,
          owner: OWNER,
          at: NOW_S,
        },
      ])
    })

    it("downloads the payload the reference points at", async () => {
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      expect(await reader.downloadPayload({ at: AT })).toEqual({
        reference: ENCRYPTED_REF,
        payload: PAYLOAD,
        encryptionKey: ENCRYPTED_REF.slice(64),
      })
      expect(sent()).toEqual([
        {
          type: "epochFeedDownloadReference",
          topic: TOPIC,
          owner: OWNER,
          at: AT.toString(),
        },
        { type: "downloadData", reference: ENCRYPTED_REF },
      ])
    })

    it("downloads no payload when the feed has no entry", async () => {
      answers.epochFeedDownloadReference = () => ({ reference: undefined })
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      expect(await reader.downloadPayload({ at: AT })).toEqual({
        reference: undefined,
        payload: undefined,
        encryptionKey: undefined,
      })
      expect(sent().map((m) => m.type)).toEqual(["epochFeedDownloadReference"])
    })

    it("downloads a raw reference without a key", async () => {
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      expect(
        await reader.downloadRawReference({ at: AT, after: AFTER }),
      ).toEqual({ reference: ENCRYPTED_REF, encryptionKey: undefined })
      expect(sent()).toEqual([
        {
          type: "epochFeedDownloadReference",
          topic: TOPIC,
          owner: OWNER,
          at: AT.toString(),
          after: AFTER.toString(),
        },
      ])
    })

    it("downloads a raw payload without a key", async () => {
      const reader = client.makeEpochFeedReader({ topic: TOPIC, owner: OWNER })
      expect(await reader.downloadRawPayload({ at: AT })).toEqual({
        reference: ENCRYPTED_REF,
        payload: PAYLOAD,
        encryptionKey: undefined,
      })
      expect(sent().map((m) => m.type)).toEqual([
        "epochFeedDownloadReference",
        "downloadData",
      ])
    })
  })

  describe("epoch writer", () => {
    it("knows its signer's owner without asking", async () => {
      const writer = client.makeEpochFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      expect(await writer.getOwner()).toBe(SIGNER_OWNER)
      expect(sent()).toEqual([])
    })

    it("asks the proxy for the owner without a signer", async () => {
      const writer = client.makeEpochFeedWriter({ topic: TOPIC })
      expect(await writer.getOwner()).toBe(PROXY_OWNER)
      expect(sent()).toEqual([{ type: "feedGetOwner" }])
    })

    it("reads like the reader, with its signer's owner", async () => {
      const writer = client.makeEpochFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      expect(
        await writer.downloadReference({ at: AT, encryptionKey: KEY }),
      ).toEqual({
        reference: ENCRYPTED_REF,
        encryptionKey: ENCRYPTED_REF.slice(64),
      })
      expect(await writer.downloadPayload({ at: AT })).toMatchObject({
        payload: PAYLOAD,
      })
      expect(await writer.downloadRawReference({ at: AT })).toEqual({
        reference: ENCRYPTED_REF,
        encryptionKey: undefined,
      })
      expect(await writer.downloadRawPayload({ at: AT })).toMatchObject({
        payload: PAYLOAD,
        encryptionKey: undefined,
      })
      const read = {
        type: "epochFeedDownloadReference",
        topic: TOPIC,
        owner: SIGNER_OWNER,
        at: AT.toString(),
      }
      expect(sent()).toEqual([
        { ...read, encryptionKey: KEY },
        read,
        { type: "downloadData", reference: ENCRYPTED_REF },
        read,
        read,
        { type: "downloadData", reference: ENCRYPTED_REF },
      ])
    })

    it("uploads an encrypted reference under the key it carries", async () => {
      const writer = client.makeEpochFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      const result = await writer.uploadReference(ENCRYPTED_REF, {
        at: AT,
        hints: HINTS,
        batchID: BATCH,
      })
      expect(result).toEqual({
        socAddress: SOC_ADDRESS,
        reference: ENCRYPTED_REF,
        encryptionKey: ENCRYPTED_REF.slice(64),
        epoch: { start: NOW_S, level: 0 },
        timestamp: NOW_S,
      })
      expect(sent()).toEqual([
        {
          type: "epochFeedUploadReference",
          topic: TOPIC,
          signer: SIGNER.toHex(),
          at: AT.toString(),
          reference: ENCRYPTED_REF,
          encryptionKey: ENCRYPTED_REF.slice(64),
          hints: HINTS,
          batchID: BATCH,
        },
      ])
    })

    it("uploads a plain reference under a given key, to the upload options' drive", async () => {
      const writer = client.makeEpochFeedWriter({ topic: TOPIC })
      const result = await writer.uploadReference(REF, {
        at: AT,
        encryptionKey: KEY,
        uploadOptions: { batchID: OTHER_BATCH },
      })
      expect(result.encryptionKey).toBeUndefined()
      expect(sent()).toEqual([
        {
          type: "epochFeedUploadReference",
          topic: TOPIC,
          at: AT.toString(),
          reference: REF,
          encryptionKey: KEY,
          batchID: OTHER_BATCH,
        },
      ])
    })

    it("uploads a payload encrypted, then its reference, to one drive", async () => {
      const writer = client.makeEpochFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      const result = await writer.uploadPayload(DATA, {
        at: AT,
        batchID: BATCH,
      })
      expect(result).toEqual({
        socAddress: SOC_ADDRESS,
        reference: ENCRYPTED_REF,
        encryptionKey: ENCRYPTED_REF.slice(64),
        epoch: { start: NOW_S, level: 0 },
        timestamp: NOW_S,
      })
      expect(sent()).toEqual([
        {
          type: "uploadData",
          data: DATA,
          options: { encrypt: true, batchID: BATCH },
          enableProgress: false,
        },
        {
          type: "epochFeedUploadReference",
          topic: TOPIC,
          signer: SIGNER.toHex(),
          at: AT.toString(),
          reference: ENCRYPTED_REF,
          encryptionKey: ENCRYPTED_REF.slice(64),
          batchID: BATCH,
        },
      ])
    })

    it("uploads a payload unencrypted when asked, under a given key", async () => {
      answers.uploadData = () => ({ reference: REF })
      const writer = client.makeEpochFeedWriter({ topic: TOPIC })
      const result = await writer.uploadPayload(DATA, {
        at: AT,
        encrypt: false,
        encryptionKey: KEY,
      })
      expect(result.encryptionKey).toBeUndefined()
      expect(sent()).toEqual([
        {
          type: "uploadData",
          data: DATA,
          options: { encrypt: false },
          enableProgress: false,
        },
        {
          type: "epochFeedUploadReference",
          topic: TOPIC,
          at: AT.toString(),
          reference: REF,
          encryptionKey: KEY,
        },
      ])
    })

    it("uploads a raw reference with no key and no drive", async () => {
      const writer = client.makeEpochFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      const result = await writer.uploadRawReference(ENCRYPTED_REF, {
        at: AT,
        hints: HINTS,
        batchID: BATCH,
      })
      expect(result).toEqual({
        socAddress: SOC_ADDRESS,
        reference: ENCRYPTED_REF,
        encryptionKey: undefined,
        epoch: { start: NOW_S, level: 0 },
        timestamp: NOW_S,
      })
      expect(sent()).toEqual([
        {
          type: "epochFeedUploadReference",
          topic: TOPIC,
          signer: SIGNER.toHex(),
          at: AT.toString(),
          reference: ENCRYPTED_REF,
          hints: HINTS,
        },
      ])
    })

    it("uploads a raw payload unencrypted, its reference with no drive", async () => {
      answers.uploadData = () => ({ reference: REF })
      const writer = client.makeEpochFeedWriter({ topic: TOPIC })
      const result = await writer.uploadRawPayload(DATA, {
        at: AT,
        uploadOptions: { batchID: BATCH },
      })
      expect(result.encryptionKey).toBeUndefined()
      expect(sent()).toEqual([
        {
          type: "uploadData",
          data: DATA,
          options: { batchID: BATCH, encrypt: false },
          enableProgress: false,
        },
        {
          type: "epochFeedUploadReference",
          topic: TOPIC,
          at: AT.toString(),
          reference: REF,
        },
      ])
    })
  })

  describe("sequential reader", () => {
    it("asks the proxy for the owner once, and reads with it after", async () => {
      const reader = client.makeSequentialFeedReader({ topic: TOPIC })
      expect(await reader.getOwner()).toBe(PROXY_OWNER)
      await reader.downloadRawPayload()
      expect(sent()).toEqual([
        { type: "seqFeedGetOwner" },
        { type: "seqFeedDownloadRawPayload", topic: TOPIC, owner: PROXY_OWNER },
      ])
    })

    it("downloads a payload", async () => {
      const reader = client.makeSequentialFeedReader({
        topic: TOPIC,
        owner: OWNER,
      })
      const result = await reader.downloadPayload(KEY, {
        index: INDEX,
        at: AT,
        hasTimestamp: true,
        lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
      })
      expect(result).toEqual(seqPayloadAnswer())
      expect(sent()).toEqual([
        {
          type: "seqFeedDownloadPayload",
          topic: TOPIC,
          owner: OWNER,
          index: INDEX.toString(),
          at: AT.toString(),
          hasTimestamp: true,
          lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
          encryptionKey: KEY,
        },
      ])
    })

    it("downloads a raw payload", async () => {
      const reader = client.makeSequentialFeedReader({
        topic: TOPIC,
        owner: OWNER,
      })
      const result = await reader.downloadRawPayload({
        index: INDEX,
        encryptionKey: KEY,
        lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
      })
      expect(result).toEqual(seqPayloadAnswer())
      expect(sent()).toEqual([
        {
          type: "seqFeedDownloadRawPayload",
          topic: TOPIC,
          owner: OWNER,
          index: INDEX.toString(),
          lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
          encryptionKey: KEY,
        },
      ])
    })

    it("downloads a reference", async () => {
      const reader = client.makeSequentialFeedReader({
        topic: TOPIC,
        owner: OWNER,
      })
      const result = await reader.downloadReference(KEY, {
        at: AT,
        lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
      })
      expect(result).toEqual({
        reference: REF,
        feedIndex: "3",
        feedIndexNext: "4",
      })
      expect(sent()).toEqual([
        {
          type: "seqFeedDownloadReference",
          topic: TOPIC,
          owner: OWNER,
          at: AT.toString(),
          lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
          encryptionKey: KEY,
        },
      ])
    })
  })

  describe("sequential writer", () => {
    it("knows its signer's owner without asking", async () => {
      const writer = client.makeSequentialFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      expect(await writer.getOwner()).toBe(SIGNER_OWNER)
      expect(sent()).toEqual([])
    })

    it("reads as the owner its last upload reported", async () => {
      const writer = client.makeSequentialFeedWriter({ topic: TOPIC })
      await writer.uploadReference(REF)
      expect(await writer.getOwner()).toBe(WRITER_OWNER)
      await writer.downloadReference(KEY)
      expect(sent()).toEqual([
        { type: "seqFeedUploadReference", topic: TOPIC, reference: REF },
        {
          type: "seqFeedDownloadReference",
          topic: TOPIC,
          owner: WRITER_OWNER,
          encryptionKey: KEY,
        },
      ])
    })

    it("uploads a payload", async () => {
      const writer = client.makeSequentialFeedWriter({
        topic: TOPIC,
        signer: SIGNER,
      })
      const options = {
        index: INDEX,
        at: AT,
        hasTimestamp: true,
        lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
      }
      const result = await writer.uploadPayload(DATA, options)
      expect(result).toEqual(seqUploadAnswer())
      expect(sent()).toEqual([
        {
          type: "seqFeedUploadPayload",
          topic: TOPIC,
          signer: SIGNER.toHex(),
          data: DATA,
          index: INDEX.toString(),
          at: AT.toString(),
          hasTimestamp: true,
          lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
          options,
        },
      ])
    })

    it("uploads a raw payload", async () => {
      const writer = client.makeSequentialFeedWriter({ topic: TOPIC })
      const options = { encryptionKey: KEY }
      expect(await writer.uploadRawPayload(DATA, options)).toEqual(
        seqUploadAnswer(),
      )
      expect(sent()).toEqual([
        {
          type: "seqFeedUploadRawPayload",
          topic: TOPIC,
          data: DATA,
          encryptionKey: KEY,
          options,
        },
      ])
    })

    it("uploads a reference", async () => {
      const writer = client.makeSequentialFeedWriter({ topic: TOPIC })
      const options = { index: INDEX }
      expect(await writer.uploadReference(REF, options)).toEqual(
        seqUploadAnswer(),
      )
      expect(sent()).toEqual([
        {
          type: "seqFeedUploadReference",
          topic: TOPIC,
          reference: REF,
          index: INDEX.toString(),
          options,
        },
      ])
    })
  })
})
