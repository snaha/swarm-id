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
 * Attempt to create a tag for upload progress tracking.
 * Returns the tag UID on success, or undefined if the node
 * does not support tags (e.g., gateway nodes return 404).
 *
 * Only a definitive 404 (the endpoint is unsupported) is cached per `Bee`; a
 * transient failure (5xx / network / timeout) is NOT cached, so a later upload
 * re-probes the node instead of being permanently tag-less after one blip.
 */
export async function tryCreateTag(bee: Bee): Promise<number | undefined> {
  if (tagsUnsupported.get(bee)) {
    return undefined
  }
  try {
    const tagResponse = await bee.createTag()
    return tagResponse.uid
  } catch (error) {
    // A 404 means the node doesn't implement `POST /tags` — cache it so every
    // subsequent upload skips the round-trip. Anything else is transient: skip
    // the tag this once, but leave the cache clear so we re-probe next time.
    // Decide on the response STATUS (`BeeResponseError.status`), never the
    // message text — a 5xx whose body merely mentions "404" must not poison the
    // cache.
    const unsupported = isStatus(error, NOT_FOUND)
    if (unsupported) {
      tagsUnsupported.set(bee, true)
    }
    console.warn(
      `[tryCreateTag] Tag creation failed — proceeding without tag${
        unsupported
          ? " (node does not support tags; cached, will not retry on this node)"
          : " (transient; will re-probe on the next upload)"
      }`,
    )
    return undefined
  }
}
