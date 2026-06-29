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

/**
 * Attempt to create a tag for upload progress tracking.
 * Returns the tag UID on success, or undefined if the node
 * does not support tags (e.g., gateway nodes return 404).
 *
 * The "unsupported" verdict is cached per `Bee`, so once a node has 404'd we
 * skip the `POST /tags` attempt on every subsequent upload.
 */
export async function tryCreateTag(bee: Bee): Promise<number | undefined> {
  if (tagsUnsupported.get(bee)) {
    return undefined
  }
  try {
    const tagResponse = await bee.createTag()
    return tagResponse.uid
  } catch {
    tagsUnsupported.set(bee, true)
    console.warn(
      "[tryCreateTag] Tag creation failed — node may not support tags, proceeding without tag (cached; will not retry on this node)",
    )
    return undefined
  }
}
