// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MantarayNode } from "@ethersphere/core-sdk"
import type { Bee, BeeRequestOptions } from "@ethersphere/bee-js"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
} from "../chunk"
import { hexToUint8Array, uint8ArrayToHex } from "../utils/hex"
import { downloadDataWithChunkAPI } from "./download-data"

/**
 * Upload callback type for saveMantarayTreeRecursively
 */
export type UploadCallback = (
  data: Uint8Array,
  isRoot: boolean,
) => Promise<{ reference: string; tagUid?: number }>

/**
 * Save a Mantaray tree by uploading bottom-up
 *
 * This mirrors MantarayNode.saveRecursively() but allows custom upload logic
 * and uses Bee's returned references to avoid address mismatches.
 *
 * This is the variant that is safe to use from outside the proxy: the callback
 * receives a marshaled node payload and hands back the reference it was stored
 * under, so any uploader that wraps a payload in a chunk of its own fits.
 * `SwarmIdClient.uploadData` is the one to reach for — `uploadChunk` fits the
 * contract too, but a node payload over its 4 KB chunk limit (a wide directory)
 * fails there, which is why the demo's feed upload uses `uploadData`.
 */
export async function saveMantarayTreeRecursively(
  node: MantarayNode,
  uploadFn: UploadCallback,
): Promise<{ rootReference: string; tagUid?: number }> {
  async function saveRecursively(
    current: MantarayNode,
    isRoot: boolean,
  ): Promise<{ reference: string; tagUid?: number }> {
    for (const fork of current.forks.values()) {
      await saveRecursively(fork.node, false)
    }

    const data = await current.marshal()
    const result = await uploadFn(data, isRoot)
    current.selfAddress = hexToUint8Array(result.reference)

    return result
  }

  const result = await saveRecursively(node, true)

  return {
    rootReference: result.reference,
    tagUid: result.tagUid,
  }
}

/**
 * Options for saveMantarayTree
 */
export interface SaveMantarayOptions {
  /** Encrypt manifest chunks (64-byte references with address + key) */
  encrypt?: boolean
}

/**
 * Upload callback for saveMantarayTree
 *
 * @param chunkData - A finished content-addressed chunk, span header included;
 *   it must be stored exactly as given, not wrapped in another chunk
 * @param isRoot - Whether this is the root node
 * @returns Upload result with optional tag UID
 */
export type MantarayUploadCallback = (
  chunkData: Uint8Array,
  isRoot: boolean,
) => Promise<{ tagUid?: number }>

/**
 * Save a Mantaray tree by uploading bottom-up with unified encryption support
 *
 * Proxy-internal, and deliberately not part of the package's public API.
 *
 * Creates CAC or encrypted CAC internally based on encrypt option.
 * Returns 64-byte reference (address + key) when encrypted, 32-byte otherwise.
 *
 * `uploadFn` receives a finished content-addressed chunk built here, span
 * header included, and each node's address is computed locally from those same
 * bytes. The callback must therefore store them as-is: an uploader that treats
 * its argument as a payload and wraps it in a new chunk stores every node under
 * a different address than the tree records, which fails silently and leaves the
 * returned root reference pointing at nothing. `SwarmIdClient.uploadChunk` wraps
 * its input that way and cannot be used here; no public client method accepts a
 * finished chunk. Outside the proxy, use `saveMantarayTreeRecursively` instead.
 *
 * @param node - Root Mantaray node to save
 * @param uploadFn - Callback that uploads each finished chunk verbatim
 * @param options - Optional settings (encrypt: boolean)
 * @returns Root reference and optional tag UID
 */
export async function saveMantarayTree(
  node: MantarayNode,
  uploadFn: MantarayUploadCallback,
  options?: SaveMantarayOptions,
): Promise<{ rootReference: string; tagUid?: number }> {
  const shouldEncrypt = options?.encrypt === true

  async function saveRecursively(
    current: MantarayNode,
    isRoot: boolean,
  ): Promise<{ tagUid?: number }> {
    // Process children first (bottom-up)
    for (const fork of current.forks.values()) {
      await saveRecursively(fork.node, false)
    }

    const data = await current.marshal()

    if (shouldEncrypt) {
      const encryptedChunk = makeEncryptedContentAddressedChunk(data)
      const result = await uploadFn(encryptedChunk.data, isRoot)

      // 64-byte reference: address + encryption key
      const encryptedRef = new Uint8Array(64)
      encryptedRef.set(encryptedChunk.address.toUint8Array(), 0)
      encryptedRef.set(encryptedChunk.encryptionKey, 32)
      current.selfAddress = encryptedRef

      return result
    } else {
      const chunk = makeContentAddressedChunk(data)
      const result = await uploadFn(chunk.data, isRoot)
      current.selfAddress = chunk.address.toUint8Array()
      return result
    }
  }

  const result = await saveRecursively(node, true)

  return {
    rootReference: uint8ArrayToHex(node.selfAddress!),
    tagUid: result.tagUid,
  }
}

/**
 * bee-js's own wording when the version hash at the head of a node does not
 * match — the one failure every non-manifest chunk produces, whatever its
 * size. bee-js throws a plain `Error` for it, so the text is the only handle
 * there is; if bee-js rewords it, the translation below simply stops firing
 * and the raw message surfaces again.
 */
const INVALID_VERSION_HASH_MESSAGE =
  "MantarayNode#unmarshal invalid version hash"

/**
 * What a person can act on when the root of a "file" download is not a
 * manifest at all.
 */
const NO_MANIFEST_MESSAGE =
  "This reference has no manifest: it was uploaded with uploadData, so download it with downloadData."

/**
 * Unmarshal the root node of a manifest, translating the one parse failure
 * that means "this reference is not a manifest".
 *
 * Uploads and downloads come in pairs, and both downloads take a plain
 * string reference: handing a `uploadData` reference to a file download
 * type-checks, and lands here. Only the root is translated — a root that
 * fails to parse is routinely just plain data, while a child that fails to
 * parse is a manifest with a corrupt node, which is a different problem and
 * keeps its own error.
 */
function unmarshalRootManifest(
  rootData: Uint8Array,
  rootReference: string,
): MantarayNode {
  try {
    return MantarayNode.unmarshalFromData(
      rootData,
      hexToUint8Array(rootReference),
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === INVALID_VERSION_HASH_MESSAGE
    ) {
      throw new Error(NO_MANIFEST_MESSAGE, { cause: error })
    }
    throw error
  }
}

/**
 * Load a Mantaray tree using only the chunk API.
 *
 * This avoids /bytes and supports encrypted references.
 */
export async function loadMantarayTreeWithChunkAPI(
  bee: Bee,
  rootReference: string,
  requestOptions?: BeeRequestOptions,
): Promise<MantarayNode> {
  const rootData = await downloadDataWithChunkAPI(
    bee,
    rootReference,
    undefined,
    undefined,
    requestOptions,
  )
  const root = unmarshalRootManifest(rootData, rootReference)

  async function loadRecursively(node: MantarayNode): Promise<void> {
    for (const fork of node.forks.values()) {
      if (!fork.node.selfAddress) {
        throw new Error("Fork node selfAddress is not set")
      }

      const childRef = uint8ArrayToHex(fork.node.selfAddress)
      const childData = await downloadDataWithChunkAPI(
        bee,
        childRef,
        undefined,
        undefined,
        requestOptions,
      )
      const childNode = MantarayNode.unmarshalFromData(
        childData,
        fork.node.selfAddress,
      )

      fork.node.targetAddress = childNode.targetAddress
      fork.node.forks = childNode.forks
      fork.node.obfuscationKey = childNode.obfuscationKey
      fork.node.path = fork.prefix
      fork.node.parent = node

      for (const nestedFork of fork.node.forks.values()) {
        nestedFork.node.parent = fork.node
      }

      await loadRecursively(fork.node)
    }
  }

  await loadRecursively(root)
  return root
}
