// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stamp worker's message protocol and handler, kept free of any Worker
 * global so the main thread's tests can drive it in-process. `stamp-worker.ts`
 * is the entry point that wires it to `self.onmessage`.
 *
 * Imports only from core-sdk and the hex helpers — no DOM dependencies, fully worker-compatible.
 */

import {
  Bytes,
  keccak256,
  numberToUint256,
  privateKeyToPublicKey,
  publicKeyToAddress,
  signMessage,
  uint256ToNumber,
} from "@ethersphere/core-sdk"
import { hexToUint8Array, uint8ArrayToHex } from "../utils/hex"

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
 * Signs as core-sdk's `PrivateKey.sign()` does:
 *   1. digest = concat(ETH_PREFIX, keccak256(message))
 *   2. [r, s, v] = signMessage(digest, privateKey)
 *   3. signature = concat(r[32], s[32], v[1])
 */
export function handleMessage(msg: StampWorkerMessage): StampWorkerResponse {
  if (msg.type === "init") {
    const keyBytes = hexToUint8Array(msg.signerKeyHex)
    privateKeyBigInt = uint256ToNumber(keyBytes, "BE")

    // Derive issuer address: publicKey → keccak256 → last 20 bytes
    const [x, y] = privateKeyToPublicKey(privateKeyBigInt)
    const pubKeyBytes = Bytes.concat(
      numberToUint256(x, "BE"),
      numberToUint256(y, "BE"),
    )
    const [px, py] = [
      uint256ToNumber(pubKeyBytes.slice(0, 32), "BE"),
      uint256ToNumber(pubKeyBytes.slice(32, 64), "BE"),
    ]
    issuerBytes = publicKeyToAddress([px, py])

    return { type: "ready", issuerHex: uint8ArrayToHex(issuerBytes) }
  }

  // type === 'sign'
  const digest = Bytes.concat(ETH_PREFIX, keccak256(msg.message))
  const [r, s, v] = signMessage(digest, privateKeyBigInt)
  const signature = Bytes.concat(
    numberToUint256(r, "BE"),
    numberToUint256(s, "BE"),
    new Uint8Array([Number(v)]),
  )
  return {
    type: "signed",
    id: msg.id,
    signatureHex: uint8ArrayToHex(signature),
  }
}
