// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Folder upload and listing (#750): one manifest with a fork per file, the
 * shape a gateway serves at `/bzz/<reference>/<path>`. Proxy-side, so the
 * caller never touches a Mantaray node.
 */

import { NULL_ADDRESS } from "@ethersphere/bee-js"
import type { Bee, BeeRequestOptions } from "@ethersphere/bee-js"
import { MantarayNode } from "@ethersphere/core-sdk"
import { uploadData, uploadChunk, type UploadTarget } from "./upload"
import { saveMantarayTree, loadMantarayTreeWithChunkAPI } from "./mantaray"
import { hexToUint8Array, uint8ArrayToHex } from "../utils/hex"
import type { UploadProgress, CollectionFile, CollectionEntry } from "../types"

const DEFAULT_CONTENT_TYPE = "application/octet-stream"

export interface UploadCollectionOptions {
  /** Encrypt file content (default true). `false` also leaves the manifest plain */
  encrypt?: boolean
  /** Encrypt the manifest too, so the root reference carries a key (default true) */
  encryptManifest?: boolean
  pin?: boolean
  deferred?: boolean
  tag?: number
  /** Served for the bare `/bzz/<reference>/` (`website-index-document`) */
  indexDocument?: string
  /** Served for a path that is not in the folder (`website-error-document`) */
  errorDocument?: string
  /** Called once per file */
  onProgress?: (progress: UploadProgress) => void
  requestOptions?: BeeRequestOptions
}

export async function uploadCollection(
  target: UploadTarget,
  files: CollectionFile[],
  options?: UploadCollectionOptions,
): Promise<{ reference: string; tagUid?: number }> {
  const encryptContent = options?.encrypt !== false
  const encryptManifest = encryptContent && options?.encryptManifest !== false
  const chunkOptions = {
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions: options?.requestOptions,
  }

  const manifest = new MantarayNode()
  let processed = 0
  for (const file of files) {
    const { reference } = await uploadData(target, file.data, {
      ...chunkOptions,
      encryptionKey: encryptContent ? true : undefined,
    })
    manifest.addFork(file.path, hexToUint8Array(reference), {
      "Content-Type": file.contentType ?? DEFAULT_CONTENT_TYPE,
      Filename: file.path.split("/").pop() ?? file.path,
    })
    processed++
    options?.onProgress?.({ total: files.length, processed })
  }

  const docs: Record<string, string> = {}
  if (options?.indexDocument) {
    docs["website-index-document"] = options.indexDocument
  }
  if (options?.errorDocument) {
    docs["website-error-document"] = options.errorDocument
  }
  if (Object.keys(docs).length > 0) manifest.addFork("/", NULL_ADDRESS, docs)

  const { rootReference, tagUid } = await saveMantarayTree(
    manifest,
    async (chunkData, isRoot) => {
      await uploadChunk(target, chunkData, chunkOptions)
      return { tagUid: isRoot ? options?.tag : undefined }
    },
    { encrypt: encryptManifest },
  )
  return { reference: rootReference, tagUid }
}

/** The files of a manifest: every node with content, the docs fork excluded. */
export async function listCollection(
  bee: Bee,
  reference: string,
  requestOptions?: BeeRequestOptions,
): Promise<CollectionEntry[]> {
  const manifest = await loadMantarayTreeWithChunkAPI(
    bee,
    reference,
    requestOptions,
  )
  return manifest
    .collect()
    .filter((node) => node.fullPathString !== "/")
    .map((node) => ({
      path: node.fullPathString,
      reference: uint8ArrayToHex(node.targetAddress),
      contentType: node.metadata?.["Content-Type"],
    }))
}
