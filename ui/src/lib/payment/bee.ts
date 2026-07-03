// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type BatchId, Bee, Identifier, PrivateKey, Stamper } from '@ethersphere/bee-js'
import { type UploadTarget, rejectAfter, uploadSOC } from '@snaha/swarm-id'

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
// batch owner, funds, depth) BEFORE the chunk enters pushsync, so a bad signer
// is refused with a fast 4xx. A valid stamp is accepted and only then pushsynced
// — which can be slow or (on a misconfigured node) never receipt. So a definitive
// 4xx is the only reliable "can't stamp" signal; a timeout / 5xx / network error
// means "accepted, receipt pending" and must NOT reject a valid batch.
const NODE_REJECTED = /SOC upload failed: 4\d\d/

/**
 * Prove a (batchID, signerKey) pair can actually stamp uploads by writing one
 * tiny stamped SOC. `getPostageBatch` only proves the batch exists; this proves
 * the signer owns/can-stamp it. Returns false ONLY when the node definitively
 * rejects the stamp (4xx); a timeout or other error is inconclusive (the caller
 * already reached the node for the metadata lookup) and returns true so a slow
 * pushsync can't turn a valid batch away.
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
    return !NODE_REJECTED.test(error instanceof Error ? error.message : '')
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
