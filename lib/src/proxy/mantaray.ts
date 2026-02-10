import { MantarayNode } from "@ethersphere/bee-js"
import type { Bee, BeeRequestOptions } from "@ethersphere/bee-js"
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
  const root = MantarayNode.unmarshalFromData(
    rootData,
    hexToUint8Array(rootReference),
  )

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
