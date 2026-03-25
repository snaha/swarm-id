/**
 * Web Worker for parallel ECDSA stamp signing.
 *
 * This worker receives stamp messages (address + batchId + index + timestamp)
 * and returns secp256k1 ECDSA signatures. The bucket assignment (stateful, fast)
 * stays on the main thread; only the signing (stateless, slow ~4ms) runs here.
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
 * Handle incoming messages from the main thread.
 *
 * Replicates bee-js PrivateKey.sign() logic:
 *   1. digest = concat(ETH_PREFIX, keccak256(message))
 *   2. [r, s, v] = Elliptic.signMessage(digest, privateKey)
 *   3. signature = concat(r[32], s[32], v[1])
 */
function handleMessage(msg: StampWorkerMessage): StampWorkerResponse {
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

// Worker entry point — only runs in Worker context
interface WorkerGlobalScopeMinimal {
  onmessage: ((event: MessageEvent<StampWorkerMessage>) => void) | undefined
  postMessage(message: StampWorkerResponse): void
}

const workerSelf = self as unknown as WorkerGlobalScopeMinimal

workerSelf.onmessage = (event: MessageEvent<StampWorkerMessage>) => {
  const response = handleMessage(event.data)
  workerSelf.postMessage(response)
}
