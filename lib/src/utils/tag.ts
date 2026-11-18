// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Bee } from "@ethersphere/bee-js"

/**
 * Nodes that have already 404'd `POST /tags` (e.g. public gateways). Keyed per
 * `Bee` so the verdict is scoped to the node URL — pointing at a real node
 * later uses a different `Bee` and re-probes. Without this, every upload retries
 * the same failing round-trip on the critical path.
 */
const tagsUnsupported = new WeakMap<Bee, boolean>()

/** HTTP status for an unimplemented endpoint. */
const NOT_FOUND = 404

/** True when `error` carries a numeric HTTP `status` equal to `status`
 *  (`BeeResponseError.status`); false for any error without that field. */
function isStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === status
  )
}

/**
 * Create a tag, or `undefined` when the node does not support tags: it 404s
 * `POST /tags` (e.g. a public gateway), a verdict cached per `Bee`. Any other
 * failure (5xx / network / timeout) is rethrown and NOT cached, so a later
 * upload re-probes the node instead of being permanently tag-less after one
 * blip. The verdict rests on the response STATUS (`BeeResponseError.status`),
 * never the message text: a 5xx whose body merely mentions "404" must not
 * poison the cache.
 */
export async function createTagIfSupported(
  bee: Bee,
): Promise<number | undefined> {
  if (tagsUnsupported.get(bee)) {
    return undefined
  }
  try {
    const tagResponse = await bee.tag.create()
    return tagResponse.uid
  } catch (error) {
    if (!isStatus(error, NOT_FOUND)) throw error
    tagsUnsupported.set(bee, true)
    return undefined
  }
}

/**
 * Attempt to create a tag for upload progress tracking.
 * Returns the tag UID on success, or undefined if the node
 * does not support tags (e.g., gateway nodes return 404) or the attempt
 * failed transiently, which skips the tag this once and re-probes next time.
 */
export async function tryCreateTag(bee: Bee): Promise<number | undefined> {
  const knownUnsupported = tagsUnsupported.get(bee)
  try {
    const tag = await createTagIfSupported(bee)
    if (tag === undefined && !knownUnsupported) {
      console.warn(
        "[tryCreateTag] Tag creation failed — proceeding without tag (node does not support tags; cached, will not retry on this node)",
      )
    }
    return tag
  } catch {
    console.warn(
      "[tryCreateTag] Tag creation failed — proceeding without tag (transient; will re-probe on the next upload)",
    )
    return undefined
  }
}
