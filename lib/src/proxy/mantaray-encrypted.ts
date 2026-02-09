import { makeEncryptedContentAddressedChunk } from "@ethersphere/bee-js"
import type { MantarayNode, EncryptedChunk } from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "../utils/hex"

/**
 * Upload callback type for saveMantarayTreeRecursivelyEncrypted
 *
 * @param encryptedData - The encrypted chunk data to upload
 * @param address - The 32-byte address of the encrypted chunk
 * @param isRoot - Whether this is the root node
 * @returns Upload result with optional tag UID
 */
export type EncryptedUploadCallback = (
  encryptedData: Uint8Array,
  address: Uint8Array,
  isRoot: boolean,
) => Promise<{ tagUid?: number }>

/**
 * Save a Mantaray tree with encryption by uploading bottom-up
 *
 * This mirrors saveMantarayTreeRecursively but encrypts each manifest node
 * and creates 64-byte encrypted references (address + encryption key).
 *
 * @param node - Root Mantaray node to save
 * @param uploadFn - Callback to upload each encrypted chunk
 * @returns Root reference (128 hex chars = 64 bytes) and optional tag UID
 */
export async function saveMantarayTreeRecursivelyEncrypted(
  node: MantarayNode,
  uploadFn: EncryptedUploadCallback,
): Promise<{ rootReference: string; tagUid?: number }> {
  async function saveRecursively(
    current: MantarayNode,
    isRoot: boolean,
  ): Promise<{ tagUid?: number }> {
    // Process children first (bottom-up)
    for (const fork of current.forks.values()) {
      await saveRecursively(fork.node, false)
    }

    // Marshal the current node
    const data = await current.marshal()

    // Encrypt the manifest chunk
    const encryptedChunk: EncryptedChunk =
      makeEncryptedContentAddressedChunk(data)

    // Upload the encrypted chunk data
    const result = await uploadFn(
      encryptedChunk.data,
      encryptedChunk.address.toUint8Array(),
      isRoot,
    )

    // Create 64-byte reference: address + encryption key
    const encryptedRef = new Uint8Array(64)
    encryptedRef.set(encryptedChunk.address.toUint8Array(), 0)
    encryptedRef.set(encryptedChunk.encryptionKey, 32)

    // Set the node's self address to the full 64-byte encrypted reference
    current.selfAddress = encryptedRef

    return result
  }

  const result = await saveRecursively(node, true)

  return {
    rootReference: uint8ArrayToHex(node.selfAddress!),
    tagUid: result.tagUid,
  }
}
