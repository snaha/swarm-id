// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stamp worker's message protocol and handler, kept free of any Worker
 * global so the main thread's tests can drive it in-process. `stamp-worker.ts`
 * is the entry point that wires it to `self.onmessage`.
 *
 * Imports only from cafe-utility — no DOM dependencies, fully worker-compatible.
 */

import { Binary, Elliptic } from "cafe-utility"

const ENCODER = new TextEncoder()
const ETH_PREFIX = ENCODER.encode("\x19Ethereum Signed Message:\n32")

let privateKeyBigInt: bigint
let issuerBytes: Uint8Array

/**
 * Message types for main thread ↔ worker communication.
 */
export interface StampWorkerInitMessage {
  type: "init"
  signerKeyHex: string
}

export interface StampWorkerSignMessage {
  type: "sign"
  id: number
  message: Uint8Array // 80 bytes: address(32) + batchId(32) + index(8) + timestamp(8)
}

export interface StampWorkerReadyResponse {
  type: "ready"
  issuerHex: string
}

export interface StampWorkerSignedResponse {
  type: "signed"
  id: number
  signatureHex: string // 65 bytes as hex
}

export type StampWorkerMessage = StampWorkerInitMessage | StampWorkerSignMessage
export type StampWorkerResponse =
  | StampWorkerReadyResponse
  | StampWorkerSignedResponse

/**
 * Handle an incoming message from the main thread.
 *
 * Replicates core-sdk's `PrivateKey.sign()`:
 *   1. digest = concat(ETH_PREFIX, keccak256(message))
 *   2. [r, s, v] = Elliptic.signMessage(digest, privateKey)
 *   3. signature = concat(r[32], s[32], v[1])
 */
export function handleMessage(msg: StampWorkerMessage): StampWorkerResponse {
  if (msg.type === "init") {
    const keyBytes = Binary.hexToUint8Array(msg.signerKeyHex)
    privateKeyBigInt = Binary.uint256ToNumber(keyBytes, "BE")

    // Derive issuer address: publicKey → keccak256 → last 20 bytes
    const [x, y] = Elliptic.privateKeyToPublicKey(privateKeyBigInt)
    const pubKeyBytes = Binary.concatBytes(
      Binary.numberToUint256(x, "BE"),
      Binary.numberToUint256(y, "BE"),
    )
    const [px, py] = [
      Binary.uint256ToNumber(pubKeyBytes.slice(0, 32), "BE"),
      Binary.uint256ToNumber(pubKeyBytes.slice(32, 64), "BE"),
    ]
    issuerBytes = Elliptic.publicKeyToAddress([px, py])

    return { type: "ready", issuerHex: Binary.uint8ArrayToHex(issuerBytes) }
  }

  // type === 'sign'
  const digest = Binary.concatBytes(ETH_PREFIX, Binary.keccak256(msg.message))
  const [r, s, v] = Elliptic.signMessage(digest, privateKeyBigInt)
  const signature = Binary.concatBytes(
    Binary.numberToUint256(r, "BE"),
    Binary.numberToUint256(s, "BE"),
    new Uint8Array([Number(v)]),
  )
  return {
    type: "signed",
    id: msg.id,
    signatureHex: Binary.uint8ArrayToHex(signature),
  }
}
