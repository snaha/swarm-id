// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type BatchId, Bee, Identifier, PrivateKey, Stamper } from '@ethersphere/bee-js'
import { SocUploadError, type UploadTarget, rejectAfter, uploadSOC } from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

const VALIDATION_PAYLOAD = new TextEncoder().encode('swarm-id batch validation')
// A real gateway stamps + pushsyncs a valid chunk in a second or two; give it
// headroom. A slower response is treated as "accepted, receipt pending" (see
// verifyBatchStampable), so this bound only affects how long we wait before
// letting a valid-looking batch through — it never turns a valid batch away.
const VALIDATION_TIMEOUT_MS = 10000
const IDENTIFIER_BYTES = 32

// A random identifier each call → a fresh SOC address → a fresh postage bucket
// slot, so re-validating the same batch doesn't reuse a stamp index (which the
// node rejects as a double-spend). Costs one tiny chunk per validation.
function randomIdentifier(): Identifier {
  return new Identifier(crypto.getRandomValues(new Uint8Array(IDENTIFIER_BYTES)))
}

/**
 * The product UI's postage ("drive") operations against a Bee node, as a thin
 * adapter over the bee-js client. All node interaction goes through bee-js —
 * don't hand-roll fetch calls against the node API here. The node URL defaults
 * to the shared network setting (the same one the lib proxy and /dev honour),
 * so pointing the app at a different Bee node redirects these calls too.
 */

// The node validates a postage stamp synchronously at ingestion (signature vs
// batch owner, funds, depth) BEFORE the chunk enters pushsync, and refuses a bad
// stamp with 400. A 404 ("batch not found") or 422 ("batch not usable yet"),
// though, just means the node hasn't synced/warmed this batch yet — the exact
// case attach exists for — so it must NOT count as a rejection. Only a 400 is
// definitive; every other status (404/422/timeout/5xx/network) is inconclusive
// ("accepted or unknown, receipt pending") and must let a valid batch through.
const STAMP_REJECTED_STATUS = 400

/**
 * Prove a (batchID, signerKey) pair can actually stamp uploads by writing one
 * tiny stamped SOC. Checking the batch exists only proves that; this proves
 * the signer owns/can-stamp it. Returns false ONLY on a definitive stamp
 * rejection (HTTP 400); a 404/422/timeout/other error is inconclusive and
 * returns true so a freshly-bought or not-yet-synced batch isn't turned away.
 */
export async function verifyBatchStampable(
  batchId: BatchId,
  signerKey: PrivateKey,
  depth: number,
  beeUrl: string = networkSettingsStore.beeNodeUrl,
): Promise<boolean> {
  const bee = new Bee(beeUrl)
  const stamper = Stamper.fromBlank(signerKey, batchId, depth)
  const target: UploadTarget = { mode: 'stamper', bee, stamper }
  const upload = uploadSOC(target, signerKey, randomIdentifier(), VALIDATION_PAYLOAD, {
    deferred: true,
  })
  try {
    await Promise.race([upload, rejectAfter(VALIDATION_TIMEOUT_MS, 'batch validation timed out')])
    return true
  } catch (error) {
    return !(error instanceof SocUploadError && error.status === STAMP_REJECTED_STATUS)
  } finally {
    // If the timeout won the race, the upload promise is still pending; swallow
    // its eventual (unhandled) rejection.
    upload.catch(() => undefined)
  }
}

/**
 * Add funds to an existing batch, extending its lifespan. The node must own
 * the batch; rejects with the node's error otherwise. `amount` is the
 * additional per-chunk balance in PLUR.
 */
export async function topUpStamp(
  batchId: string,
  amount: bigint,
  beeUrl: string = networkSettingsStore.beeNodeUrl,
): Promise<void> {
  await new Bee(beeUrl).topUpBatch(strip0x(batchId), amount)
}

/**
 * Increase an existing batch's depth, growing its capacity. The node must own
 * the batch; rejects with the node's error otherwise. Dilution alone divides
 * the remaining lifespan across the larger capacity — callers top up too when
 * preserving the lifespan.
 */
export async function diluteStamp(
  batchId: string,
  depth: number,
  beeUrl: string = networkSettingsStore.beeNodeUrl,
): Promise<void> {
  await new Bee(beeUrl).diluteBatch(strip0x(batchId), depth)
}
