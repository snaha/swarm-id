import {
  ChunkJoiner,
  EthAddress,
  Identifier,
  Reference,
  Signature,
  calculateChunkAddress,
} from "@ethersphere/bee-js"
import type {
  Bee,
  BeeRequestOptions,
  DownloadOptions,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import type { UploadProgress } from "./types"
import type { SingleOwnerChunk } from "../types"
import { hexToUint8Array } from "../utils/hex"

const IDENTIFIER_SIZE = 32
const SIGNATURE_SIZE = 65
const SPAN_SIZE = 8
const SOC_HEADER_SIZE = IDENTIFIER_SIZE + SIGNATURE_SIZE
const KEY_LENGTH = 32

class Encryption {
  private readonly encryptionKey: Uint8Array
  private readonly keyLen: number
  private readonly padding: number
  private index: number
  private readonly initCtr: number

  constructor(key: Uint8Array, padding: number, initCtr: number) {
    this.encryptionKey = key
    this.keyLen = key.length
    this.padding = padding
    this.initCtr = initCtr
    this.index = 0
  }

  decrypt(data: Uint8Array): Uint8Array {
    const length = data.length

    if (this.padding > 0 && length !== this.padding) {
      throw new Error(
        `data length ${length} different than padding ${this.padding}`,
      )
    }

    const out = new Uint8Array(length)
    this.transform(data, out)
    return out
  }

  private transform(input: Uint8Array, out: Uint8Array): void {
    const inLength = input.length

    for (let i = 0; i < inLength; i += this.keyLen) {
      const l = Math.min(this.keyLen, inLength - i)
      this.transcrypt(
        this.index,
        input.subarray(i, i + l),
        out.subarray(i, i + l),
      )
      this.index++
    }
  }

  private transcrypt(i: number, input: Uint8Array, out: Uint8Array): void {
    const ctrBytes = new Uint8Array(4)
    const view = new DataView(ctrBytes.buffer)
    view.setUint32(0, i + this.initCtr, true)

    const keyAndCtr = new Uint8Array(this.encryptionKey.length + 4)
    keyAndCtr.set(this.encryptionKey)
    keyAndCtr.set(ctrBytes, this.encryptionKey.length)
    const ctrHash = Binary.keccak256(keyAndCtr)
    const segmentKey = Binary.keccak256(ctrHash)

    const inLength = input.length
    for (let j = 0; j < inLength; j++) {
      out[j] = input[j] ^ segmentKey[j]
    }
  }
}

function newSpanEncryption(key: Uint8Array): Encryption {
  const CHUNK_SIZE = 4096
  return new Encryption(key, 0, Math.floor(CHUNK_SIZE / KEY_LENGTH))
}

function newDataEncryption(key: Uint8Array): Encryption {
  const CHUNK_SIZE = 4096
  return new Encryption(key, CHUNK_SIZE, 0)
}

function decryptChunkData(
  key: Uint8Array,
  encryptedChunkData: Uint8Array,
): Uint8Array {
  const spanDecrypter = newSpanEncryption(key)
  const decryptedSpan = spanDecrypter.decrypt(encryptedChunkData.subarray(0, 8))

  const dataDecrypter = newDataEncryption(key)
  const decryptedData = dataDecrypter.decrypt(encryptedChunkData.subarray(8))

  const result = new Uint8Array(8 + decryptedData.length)
  result.set(decryptedSpan)
  result.set(decryptedData, 8)
  return result
}

function readSpan(spanBytes: Uint8Array): number {
  const view = new DataView(
    spanBytes.buffer,
    spanBytes.byteOffset,
    spanBytes.byteLength,
  )
  return Number(view.getBigUint64(0, true))
}

function makeSocAddress(identifier: Identifier, owner: EthAddress): Reference {
  return new Reference(
    Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
    ),
  )
}

function makeSingleOwnerChunkFromData(
  data: Uint8Array,
  address: Reference,
  expectedOwner: EthAddress,
  encryptionKey?: Uint8Array,
): SingleOwnerChunk {
  const identifier = new Identifier(data.slice(0, IDENTIFIER_SIZE))
  const signature = Signature.fromSlice(data, IDENTIFIER_SIZE)
  const cacData = data.slice(SOC_HEADER_SIZE)
  const cacAddress = calculateChunkAddress(cacData)
  const digest = Binary.concatBytes(
    identifier.toUint8Array(),
    cacAddress.toUint8Array(),
  )
  const recoveredOwner = signature.recoverPublicKey(digest).address()

  if (!recoveredOwner.equals(expectedOwner)) {
    throw new Error("SOC owner mismatch")
  }

  const socAddress = makeSocAddress(identifier, recoveredOwner)
  if (!Binary.equals(address.toUint8Array(), socAddress.toUint8Array())) {
    throw new Error("SOC data does not match given address")
  }

  let spanBytes: Uint8Array
  let payload: Uint8Array
  let rebuiltData: Uint8Array

  if (encryptionKey) {
    const decrypted = decryptChunkData(encryptionKey, cacData)
    spanBytes = decrypted.slice(0, SPAN_SIZE)
    const span = readSpan(spanBytes)
    payload = decrypted.slice(SPAN_SIZE, SPAN_SIZE + span)
    rebuiltData = Binary.concatBytes(
      identifier.toUint8Array(),
      signature.toUint8Array(),
      spanBytes,
      payload,
    )
  } else {
    spanBytes = data.slice(SOC_HEADER_SIZE, SOC_HEADER_SIZE + SPAN_SIZE)
    const span = readSpan(spanBytes)
    if (span > 4096) {
      throw new Error(
        "SOC payload length is invalid; this chunk likely requires decryption",
      )
    }
    payload = data.slice(
      SOC_HEADER_SIZE + SPAN_SIZE,
      SOC_HEADER_SIZE + SPAN_SIZE + span,
    )
    rebuiltData = data
  }

  const span = readSpan(spanBytes)

  return {
    data: rebuiltData,
    identifier: identifier.toHex(),
    signature: signature.toHex(),
    span,
    payload,
    address: address.toHex(),
    owner: recoveredOwner.toHex(),
  }
}

/**
 * Download data using only the chunk API
 * This ensures encrypted data remains encrypted during transmission and avoids metadata leakage
 *
 * Supports both:
 * - Regular references (64 hex chars = 32 bytes)
 * - Encrypted references (128 hex chars = 64 bytes: 32-byte address + 32-byte encryption key)
 */
export async function downloadDataWithChunkAPI(
  bee: Bee,
  reference: string,
  options?: DownloadOptions,
  onProgress?: (progress: UploadProgress) => void,
  requestOptions?: BeeRequestOptions,
): Promise<Uint8Array> {
  // Convert hex string to Reference
  const ref = new Reference(reference)

  // Create ChunkJoiner with progress callback
  const joiner = new ChunkJoiner(bee, ref, {
    downloadOptions: options,
    requestOptions,
    onDownloadProgress: onProgress
      ? (progress) => {
          onProgress({
            total: progress.total,
            processed: progress.processed,
          })
        }
      : undefined,
    // Use reasonable concurrency for parallel chunk fetching
    concurrency: 64,
  })

  // Download and assemble all chunks
  const data = await joiner.readAll()

  return data
}

export async function downloadSOC(
  bee: Bee,
  owner: string | Uint8Array | EthAddress,
  identifier: string | Uint8Array | Identifier,
  requestOptions?: BeeRequestOptions,
): Promise<SingleOwnerChunk> {
  const ownerAddress = new EthAddress(owner)
  const id = new Identifier(identifier)
  const socAddress = makeSocAddress(id, ownerAddress)

  const data = await bee.downloadChunk(
    socAddress.toHex(),
    undefined,
    requestOptions,
  )

  return makeSingleOwnerChunkFromData(data, socAddress, ownerAddress)
}

export async function downloadEncryptedSOC(
  bee: Bee,
  owner: string | Uint8Array | EthAddress,
  identifier: string | Uint8Array | Identifier,
  encryptionKey: string | Uint8Array,
  requestOptions?: BeeRequestOptions,
): Promise<SingleOwnerChunk> {
  const ownerAddress = new EthAddress(owner)
  const id = new Identifier(identifier)
  const socAddress = makeSocAddress(id, ownerAddress)
  const keyBytes =
    typeof encryptionKey === "string"
      ? hexToUint8Array(encryptionKey)
      : encryptionKey

  const data = await bee.downloadChunk(
    socAddress.toHex(),
    undefined,
    requestOptions,
  )

  return makeSingleOwnerChunkFromData(data, socAddress, ownerAddress, keyBytes)
}
