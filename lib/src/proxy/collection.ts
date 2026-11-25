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
import {
  uploadData,
  uploadDataStream,
  uploadChunk,
  type UploadTarget,
} from "./upload"
import { saveMantarayTree, loadMantarayTreeWithChunkAPI } from "./mantaray"
import { hexToUint8Array, uint8ArrayToHex } from "../utils/hex"
import { LOCK_YIELD_AFTER_MS } from "../utils/constants"
import type { UploadProgress, CollectionEntry } from "../types"

const DEFAULT_CONTENT_TYPE = "application/octet-stream"

/**
 * Runs `work` in one write session: the drive's write lock taken, a target
 * built for it, and the lock given up once `work` is done, with whatever the
 * session commits. A folder may take several, one after another.
 */
export type WriteSession = <T>(
  work: (target: UploadTarget) => Promise<T>,
) => Promise<T>

/**
 * One file of a folder to upload: its bytes, or a source of them read when
 * the upload gets to the file, no faster than the node takes its chunks
 */
export interface CollectionUploadFile {
  /** Path inside the folder, `/`-separated, no leading slash */
  path: string
  data: Uint8Array | AsyncIterable<Uint8Array>
  contentType?: string
}

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

/**
 * What `uploadFile` and `uploadFiles` encrypt: everything by default, so the
 * root reference carries a key. `encryptManifest: false` bares the manifest
 * over encrypted content; `encrypt: false` bares everything — a plain manifest
 * over plain content is the only shape a bare-manifest reader can use.
 */
export function manifestEncryption(
  options: { encrypt?: boolean; encryptManifest?: boolean } | undefined,
): { content: boolean; manifest: boolean } {
  const content = options?.encrypt !== false
  return { content, manifest: content && options?.encryptManifest !== false }
}

/**
 * Upload a folder's files one after another, then the manifest over them. A
 * file's reference depends on its bytes alone, so a streamed file and the
 * same bytes in memory land on one root.
 *
 * The files go up in write sessions `session` runs. One that has run for
 * {@link LOCK_YIELD_AFTER_MS} ends at the next file boundary, so other writes
 * to the drive get in, and the next file starts a new one; the manifest is
 * written in the last. A file's reference is final once its tree is up, so
 * the references carry from one session to the next.
 */
export async function uploadCollection(
  session: WriteSession,
  files: CollectionUploadFile[],
  options?: UploadCollectionOptions,
): Promise<{ reference: string; tagUid?: number }> {
  const { content: encryptContent, manifest: encryptManifest } =
    manifestEncryption(options)
  const chunkOptions = {
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions: options?.requestOptions,
  }

  // A repeated path would silently replace its earlier fork: the manifest
  // would hold fewer files than were sent while progress still counted them all.
  const paths = new Set<string>()
  for (const { path } of files) {
    if (paths.has(path)) throw new Error(`Duplicate path in folder: ${path}`)
    paths.add(path)
  }

  const manifest = new MantarayNode()
  const contentOptions = {
    ...chunkOptions,
    encryptionKey: encryptContent ? (true as const) : undefined,
  }
  let processed = 0
  const uploadFile = async (
    target: UploadTarget,
    file: CollectionUploadFile,
  ) => {
    const { reference } =
      file.data instanceof Uint8Array
        ? await uploadData(target, file.data, contentOptions)
        : await uploadDataStream(target, file.data, contentOptions)
    manifest.addFork(file.path, hexToUint8Array(reference), {
      "Content-Type": file.contentType ?? DEFAULT_CONTENT_TYPE,
      Filename: file.path.split("/").pop() ?? file.path,
    })
    processed++
    options?.onProgress?.({ total: files.length, processed })
  }

  const saveManifest = async (target: UploadTarget) => {
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

  for (;;) {
    const processedBefore = processed
    // Undefined when the session gave the lock up with files still to go.
    const saved = await session(async (target) => {
      const heldSince = Date.now()
      while (processed < files.length) {
        await uploadFile(target, files[processed])
        const yieldsHere =
          processed < files.length &&
          Date.now() - heldSince >= LOCK_YIELD_AFTER_MS
        if (yieldsHere) return undefined
      }
      return saveManifest(target)
    })
    if (saved) return saved
    // Every session but the last puts a file up: one that put none up would
    // have this loop ask for sessions forever.
    if (processed === processedBefore) {
      throw new Error("A write session ended without running the upload")
    }
  }
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
