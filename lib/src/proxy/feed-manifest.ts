import {
  MantarayNode,
  makeEncryptedContentAddressedChunk,
  makeContentAddressedChunk,
  NULL_ADDRESS,
} from "@ethersphere/bee-js"
import type {
  Bee,
  Stamper,
  UploadOptions,
  BeeRequestOptions,
} from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "../utils/hex"
import { uploadSingleChunk } from "./upload-data"
import { uploadSingleEncryptedChunk } from "./upload-encrypted-data"

/**
 * Options for creating a feed manifest
 */
export interface CreateFeedManifestOptions {
  /**
   * Whether to encrypt the manifest.
   * Default: true (encrypted)
   */
  encrypt?: boolean
  /**
   * Feed type: "Sequence" for sequential feeds, "Epoch" for epoch feeds.
   * Default: "Sequence"
   */
  feedType?: "Sequence" | "Epoch"
}

/**
 * Result of creating a feed manifest
 */
export interface CreateFeedManifestResult {
  /**
   * Reference to the feed manifest.
   * - Encrypted: 128 hex chars (64 bytes = address + encryption key)
   * - Unencrypted: 64 hex chars (32 bytes = address)
   */
  reference: string
  /**
   * Tag UID if a tag was created during upload
   */
  tagUid?: number
}

/**
 * Create a feed manifest directly using chunk upload
 *
 * Instead of using bee.createFeedManifest() which calls the /feeds endpoint,
 * this function builds the manifest locally as a MantarayNode and uploads it
 * via the encrypted chunk endpoint (or plain chunk endpoint if encrypt=false).
 *
 * Feed manifests have a single "/" path with metadata:
 * - swarm-feed-owner: Owner's ethereum address (40 hex chars, no 0x)
 * - swarm-feed-topic: Topic hash (64 hex chars)
 * - swarm-feed-type: "Sequence" for sequential feeds
 *
 * IMPORTANT: This function implements client-side "saveRecursively" logic:
 * 1. Upload the "/" child node first and get its address
 * 2. Set the child's selfAddress to the uploaded address
 * 3. Then upload the root node (which references the child's address)
 *
 * Without this, Bee's /bzz/ endpoint returns 404 because the "/" child chunk
 * doesn't exist (only its calculated hash was stored in the root manifest).
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for client-side signing
 * @param topic - Topic hex string (64 chars)
 * @param owner - Owner hex string (40 chars, no 0x prefix)
 * @param options - Options for creating the manifest (encrypt, etc.)
 * @param uploadOptions - Upload options (tag, deferred, etc.)
 * @param requestOptions - Bee request options
 * @returns Reference to the feed manifest
 */
export async function createFeedManifestDirect(
  bee: Bee,
  stamper: Stamper,
  topic: string,
  owner: string,
  options?: CreateFeedManifestOptions,
  uploadOptions?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<CreateFeedManifestResult> {
  // Normalize owner (remove 0x prefix if present)
  const normalizedOwner = owner.startsWith("0x") ? owner.slice(2) : owner

  // DEBUG: Log what Bee will use for feed lookup

  // 1. Create tag for upload if not provided
  let tag = uploadOptions?.tag
  if (!tag) {
    const tagResponse = await bee.createTag()
    tag = tagResponse.uid
  }
  const uploadOptionsWithTag = { ...uploadOptions, tag }

  // 2. Create root MantarayNode with "/" fork containing feed metadata
  const rootNode = new MantarayNode()
  rootNode.addFork("/", NULL_ADDRESS, {
    "swarm-feed-owner": normalizedOwner,
    "swarm-feed-topic": topic,
    "swarm-feed-type": options?.feedType ?? "Sequence",
  })

  // 3. Get the "/" child node (addFork created it, we need to access it)
  // 47 is ASCII code for '/'
  const slashFork = rootNode.forks.get(47)
  if (!slashFork) {
    throw new Error("[FeedManifest] Failed to create '/' fork")
  }
  const slashNode = slashFork.node

  // 4. Marshal and upload the "/" child node FIRST (saveRecursively pattern)
  // This is critical: Bee's /bzz/ needs this chunk to exist
  const slashNodeData = await slashNode.marshal()
  const slashChunk = makeContentAddressedChunk(slashNodeData)

  await uploadSingleChunk(
    bee,
    stamper,
    slashChunk,
    uploadOptionsWithTag,
    requestOptions,
  )

  // 5. Set the child's selfAddress to the uploaded chunk address
  // This is used when marshaling the root node
  slashNode.selfAddress = slashChunk.address.toUint8Array()

  // 6. Now marshal and upload the root node
  const rootNodeData = await rootNode.marshal()

  // 7. Encrypt and upload OR upload directly
  const shouldEncrypt = options?.encrypt !== false

  if (shouldEncrypt) {
    // Encrypted upload for root
    const encryptedChunk = makeEncryptedContentAddressedChunk(rootNodeData)

    await uploadSingleEncryptedChunk(
      bee,
      stamper,
      encryptedChunk,
      uploadOptionsWithTag,
      requestOptions,
    )

    // Return 64-byte reference (address + key)
    const ref = new Uint8Array(64)
    ref.set(encryptedChunk.address.toUint8Array(), 0)
    ref.set(encryptedChunk.encryptionKey, 32)
    const reference = uint8ArrayToHex(ref)

    return { reference, tagUid: tag }
  } else {
    // Unencrypted upload for root
    const rootChunk = makeContentAddressedChunk(rootNodeData)

    await uploadSingleChunk(
      bee,
      stamper,
      rootChunk,
      uploadOptionsWithTag,
      requestOptions,
    )

    // Return 32-byte reference
    const reference = rootChunk.address.toHex()

    return { reference, tagUid: tag }
  }
}
