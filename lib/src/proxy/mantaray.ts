import type { MantarayNode } from "@ethersphere/bee-js"
import { hexToUint8Array } from "../utils/hex"

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
