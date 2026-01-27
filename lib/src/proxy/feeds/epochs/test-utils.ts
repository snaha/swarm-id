/**
 * Test utilities for epoch feeds
 *
 * Provides mock storage and helpers for testing epoch feed operations
 */

import { Binary } from "cafe-utility"
import { PrivateKey, Topic, EthAddress } from "@ethersphere/bee-js"

/**
 * In-memory chunk storage for testing
 */
export class MockChunkStore {
  private chunks = new Map<string, Uint8Array>()

  async put(address: string, data: Uint8Array): Promise<void> {
    this.chunks.set(address.toLowerCase(), data)
  }

  async get(address: string): Promise<Uint8Array> {
    const data = this.chunks.get(address.toLowerCase())
    if (!data) {
      throw new Error(`Chunk not found: ${address}`)
    }
    return data
  }

  has(address: string): boolean {
    return this.chunks.has(address.toLowerCase())
  }

  clear(): void {
    this.chunks.clear()
  }

  size(): number {
    return this.chunks.size
  }
}

/**
 * Mock Bee instance for testing
 */
export class MockBee {
  public readonly url = "http://localhost:1633"
  private store: MockChunkStore
  private tagCounter = 0

  constructor(store?: MockChunkStore) {
    this.store = store || new MockChunkStore()
  }

  async createTag(): Promise<{
    uid: number
    split: number
    seen: number
    stored: number
    sent: number
    synced: number
    address: string
    startedAt: string
  }> {
    this.tagCounter++
    return {
      uid: this.tagCounter,
      split: 0,
      seen: 0,
      stored: 0,
      sent: 0,
      synced: 0,
      address: "",
      startedAt: new Date().toISOString(),
    }
  }

  async downloadChunk(reference: string): Promise<Uint8Array> {
    return this.store.get(reference)
  }

  async uploadChunk(
    data: Uint8Array,
    _postageBatchId: string,
  ): Promise<{ reference: string }> {
    const address = Binary.keccak256(data)
    const reference = Binary.uint8ArrayToHex(address)
    await this.store.put(reference, data)
    return { reference }
  }

  getStore(): MockChunkStore {
    return this.store
  }
}

/**
 * Create test signer with a deterministic private key
 */
export function createTestSigner(): PrivateKey {
  // Use a fixed private key for deterministic tests
  const privateKeyHex =
    "634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd"
  return new PrivateKey(privateKeyHex)
}

/**
 * Create test topic
 */
export function createTestTopic(name: string = "testtopic"): Topic {
  const encoder = new TextEncoder()
  const hash = Binary.keccak256(encoder.encode(name))
  return new Topic(hash)
}

/**
 * Create test owner address
 */
export function createTestOwner(): EthAddress {
  return createTestSigner().publicKey().address()
}

/**
 * Create test reference (32 bytes)
 */
export function createTestReference(value: number | bigint): Uint8Array {
  const ref = new Uint8Array(32)
  const view = new DataView(ref.buffer)
  view.setBigUint64(0, BigInt(value), false) // big-endian
  return ref
}

/**
 * Create test payload with timestamp
 */
export function createTestPayload(at: bigint): Uint8Array {
  const payload = new Uint8Array(8)
  const view = new DataView(payload.buffer)
  view.setBigUint64(0, at, false) // big-endian
  return payload
}

const BATCH_ID_LENGTH = 32
const INDEX_LENGTH = 8
const TIMESTAMP_LENGTH = 8
const SIGNATURE_LENGTH = 65
const ISSUER_LENGTH = 20
const SOC_IDENTIFIER_LENGTH = 32

/**
 * Create a mock Stamper for testing
 *
 * Returns an object with a stamp() method that produces a valid-looking
 * EnvelopeWithBatchId without performing real cryptographic operations.
 */
export function createMockStamper() {
  return {
    stamp(_chunk: any) {
      return {
        batchId: {
          toUint8Array: () => new Uint8Array(BATCH_ID_LENGTH),
        },
        index: new Uint8Array(INDEX_LENGTH),
        timestamp: new Uint8Array(TIMESTAMP_LENGTH),
        signature: new Uint8Array(SIGNATURE_LENGTH),
        issuer: new Uint8Array(ISSUER_LENGTH),
      }
    },
  }
}

/**
 * Mock fetch for SOC and chunk uploads
 *
 * Intercepts fetch calls to /soc/ and /chunks endpoints, storing data
 * in the provided MockChunkStore.
 *
 * @param store - Mock chunk store for persisting uploaded data
 * @param owner - Owner address for computing SOC addresses on /chunks uploads
 */
export function mockFetch(store?: MockChunkStore, owner?: EthAddress): void {
  const originalFetch = global.fetch

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    // Parse URL
    const urlStr = typeof url === "string" ? url : url.toString()

    // Check if it's a SOC upload
    if (urlStr.includes("/soc/")) {
      // Extract body data and SOC info from URL
      const body = init?.body as Uint8Array
      if (!body) {
        throw new Error("Missing body in SOC upload")
      }

      // Parse URL: /soc/{owner}/{id}?sig={signature}
      const parts = urlStr.split("/soc/")[1].split("/")
      const socOwner = parts[0]
      const idAndSig = parts[1].split("?sig=")
      const identifier = idAndSig[0]

      // Calculate SOC address: Keccak256(identifier || owner)
      const identifierBytes = Binary.hexToUint8Array(identifier)
      const ownerBytes = Binary.hexToUint8Array(socOwner)
      const socAddress = Binary.keccak256(
        Binary.concatBytes(identifierBytes, ownerBytes),
      )
      const reference = Binary.uint8ArrayToHex(socAddress)

      // Build full SOC chunk data (identifier + signature + span + payload)
      // For mock purposes, we need to reconstruct the full SOC
      const signatureHex = idAndSig[1]
      const signatureBytes = Binary.hexToUint8Array(signatureHex)
      const fullSOCData = Binary.concatBytes(
        identifierBytes,
        signatureBytes,
        body, // This is span + payload
      )

      // Store in mock store if provided
      if (store) {
        await store.put(reference, fullSOCData)
      }

      return new Response(JSON.stringify({ reference }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Check if it's a chunk upload (used by uploadChunkWithFetch)
    if (urlStr.includes("/chunks") && init?.method === "POST") {
      const body = init?.body as Uint8Array
      if (!body) {
        throw new Error("Missing body in chunk upload")
      }

      // SOC data starts with identifier (32 bytes)
      // Compute SOC address: Keccak256(identifier + owner)
      if (store && owner) {
        const identifier = body.slice(0, SOC_IDENTIFIER_LENGTH)
        const socAddress = Binary.keccak256(
          Binary.concatBytes(identifier, owner.toUint8Array()),
        )
        const reference = Binary.uint8ArrayToHex(socAddress)
        await store.put(reference, body)
        return new Response(JSON.stringify({ reference }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      // Fallback: store by content hash
      const address = Binary.keccak256(body)
      const reference = Binary.uint8ArrayToHex(address)
      if (store) {
        await store.put(reference, body)
      }
      return new Response(JSON.stringify({ reference }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Fall back to original fetch for other URLs
    return originalFetch(url, init)
  }
}

/**
 * Restore original fetch
 */
export function restoreFetch(): void {
  // This is a simplified version - in production you'd want to properly restore
  // For now, tests should use the mocked version throughout
}
