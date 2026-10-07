// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * User-stamp mode through a real gateway (`test/integration/gateway.ts`).
 *
 * This is the production default: Swarm ID's default Bee URL is a public
 * gateway, and every upload goes out as an envelope-stamped `POST /chunks` or
 * `POST /soc` carrying `swarm-postage-stamp`, signed client-side for the
 * user's own batch. The target is the stamper-mode suites' own, with its
 * `Bee` pointed at the gateway instead of the queen.
 *
 * Every read goes to the QUEEN, not back through the gateway: that is what
 * separates "the gateway accepted it" from "it was stamped and reached the
 * network".
 *
 * A round trip alone cannot tell whose stamp Bee used: the gateway stamps with
 * the same batch the user's stamper signs for, and it adds its own
 * `swarm-postage-batch-id` to every POST. The second block can. A stamp signed
 * by a key that does not own the batch is one Bee refuses, so the gateway
 * hands that refusal back only if it forwarded the user's stamp; had it put
 * its own batch in the stamp's place, the same upload would succeed.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import {
  BatchId,
  BeeResponseError,
  Identifier,
  PrivateKey,
  Stamper,
  type Bee,
} from "@ethersphere/bee-js"
import {
  SocUploadError,
  uploadChunk,
  uploadData,
  uploadSOC,
  type UploadTarget,
} from "../../src/proxy/upload"
import {
  downloadDataWithChunkAPI,
  downloadSOC,
} from "../../src/proxy/download-data"
import { makeContentAddressedChunk } from "../../src/chunk"
import {
  TEST_STAMP_DEPTH,
  createClusterContext,
  createQueenBee,
} from "./cluster"
import { GATEWAY_URL } from "./gateway"

/** Generate a unique random payload so each test is independent. */
function randomPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  crypto.getRandomValues(data)
  return data
}

const SMALL_PAYLOAD_SIZE = 64
const MULTI_CHUNK_PAYLOAD_SIZE = 10_000
const SOC_PAYLOAD_SIZE = 32

const HTTP_BAD_REQUEST = 400
/** Bee's `/chunks` answer when a stamp's signer is not the batch owner. */
const INVALID_STAMP_SIGNATURE = "stamp signature is invalid"
/**
 * Bee's `/soc` answer to any chunk it will not store, a bad stamp signature
 * included: the SOC handler does not tell the causes apart, so the chunk
 * tests are the ones that name the signature.
 */
const SOC_WRITE_REFUSED = "chunk write error"

/**
 * A stamper-mode target on the suite's batch whose key is not the batch
 * owner's. Its stamps are well-formed and name a batch the queen knows, so
 * the one thing wrong with them is the signature.
 */
function notOwnerTarget(bee: Bee, batchId: string): UploadTarget {
  const notTheOwner = new PrivateKey(randomPayload(PrivateKey.LENGTH))
  return {
    mode: "stamper",
    bee,
    stamper: Stamper.fromBlank(
      notTheOwner,
      new BatchId(batchId),
      TEST_STAMP_DEPTH,
    ),
  }
}

/** What a fresh chunk, stamped by a key that does not own the batch, is refused with. */
function notOwnerChunkRefusal(bee: Bee, batchId: string): Promise<unknown> {
  const { data } = makeContentAddressedChunk(randomPayload(SMALL_PAYLOAD_SIZE))
  return uploadChunk(notOwnerTarget(bee, batchId), data).catch(
    (error: unknown) => error,
  )
}

/** What a fresh SOC, stamped by a key that does not own the batch, is refused with. */
function notOwnerSocRefusal(bee: Bee, batchId: string): Promise<unknown> {
  const signer = new PrivateKey(randomPayload(PrivateKey.LENGTH))
  const identifier = new Identifier(randomPayload(Identifier.LENGTH))
  return uploadSOC(
    notOwnerTarget(bee, batchId),
    signer,
    identifier,
    randomPayload(SOC_PAYLOAD_SIZE),
  ).catch((error: unknown) => error)
}

describe("User-stamp uploads through the gateway, read back from the queen", () => {
  let queen: Bee
  let target: UploadTarget

  beforeAll(() => {
    queen = createQueenBee()
    ;({ target } = createClusterContext(inject("clusterBatchId"), GATEWAY_URL))
  })

  it("uploads small plain data", async () => {
    const data = randomPayload(SMALL_PAYLOAD_SIZE)

    const { reference } = await uploadData(target, data)
    expect(reference).toMatch(/^[0-9a-f]{64}$/)

    expect(await downloadDataWithChunkAPI(queen, reference)).toEqual(data)
  })

  // The merkle-tree branch: intermediate chunks are stamped and POSTed through
  // the gateway too, so a tree the gateway mishandled fails only here.
  it("uploads multi-chunk plain data", async () => {
    const data = randomPayload(MULTI_CHUNK_PAYLOAD_SIZE)

    const { reference } = await uploadData(target, data)

    expect(await downloadDataWithChunkAPI(queen, reference)).toEqual(data)
  })

  it("uploads encrypted data", async () => {
    const data = randomPayload(MULTI_CHUNK_PAYLOAD_SIZE)

    const { reference } = await uploadData(target, data, {
      encryptionKey: true,
    })
    // Encrypted references are 64 bytes (data ref + encryption key).
    expect(reference).toMatch(/^[0-9a-f]{128}$/)

    expect(await downloadDataWithChunkAPI(queen, reference)).toEqual(data)
  })

  // The second endpoint: `POST /soc/{owner}/{id}?sig=…` built from `bee.url`,
  // so it reaches the gateway's own `/soc` route, envelope stamp attached.
  it("uploads a single-owner chunk the queen serves back", async () => {
    const signer = new PrivateKey(randomPayload(PrivateKey.LENGTH))
    const identifier = new Identifier(randomPayload(Identifier.LENGTH))
    const data = randomPayload(SOC_PAYLOAD_SIZE)

    await uploadSOC(target, signer, identifier, data)

    const soc = await downloadSOC(
      queen,
      signer.publicKey().address(),
      identifier,
    )
    expect(soc.payload).toEqual(data)
  })
})

// Status AND message, not just "it threw": a gateway that failed the request
// itself answers 500, and Bee's other 400s (a stamp it cannot parse, a batch it
// does not know, no stamp at all) each name a different cause.
describe("The gateway forwards the user's stamp for Bee to validate", () => {
  let batchId: string
  let queen: Bee
  let gateway: Bee

  beforeAll(() => {
    batchId = inject("clusterBatchId")
    queen = createQueenBee()
    ;({ bee: gateway } = createClusterContext(batchId, GATEWAY_URL))
  })

  // The control: the stamp is bad on its own, with no gateway in the way.
  it("the queen refuses a chunk stamped by a key that does not own the batch", async () => {
    const error = await notOwnerChunkRefusal(queen, batchId)

    expect(error).toBeInstanceOf(BeeResponseError)
    expect(error).toMatchObject({
      status: HTTP_BAD_REQUEST,
      responseBody: {
        code: HTTP_BAD_REQUEST,
        message: INVALID_STAMP_SIGNATURE,
      },
    })
  })

  it("the gateway hands that refusal back rather than stamping the chunk with its own batch", async () => {
    const error = await notOwnerChunkRefusal(gateway, batchId)

    expect(error).toBeInstanceOf(BeeResponseError)
    expect(error).toMatchObject({
      status: HTTP_BAD_REQUEST,
      responseBody: {
        code: HTTP_BAD_REQUEST,
        message: INVALID_STAMP_SIGNATURE,
      },
    })
  })

  it("the queen refuses a SOC stamped by a key that does not own the batch", async () => {
    const error = await notOwnerSocRefusal(queen, batchId)

    expect(error).toBeInstanceOf(SocUploadError)
    expect(error).toMatchObject({
      status: HTTP_BAD_REQUEST,
      body: expect.stringContaining(SOC_WRITE_REFUSED),
    })
  })

  it("the gateway hands that refusal back rather than stamping the SOC with its own batch", async () => {
    const error = await notOwnerSocRefusal(gateway, batchId)

    expect(error).toBeInstanceOf(SocUploadError)
    expect(error).toMatchObject({
      status: HTTP_BAD_REQUEST,
      body: expect.stringContaining(SOC_WRITE_REFUSED),
    })
  })
})
