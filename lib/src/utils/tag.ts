// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Bee } from "@ethersphere/bee-js"

/**
 * Attempt to create a tag for upload progress tracking.
 * Returns the tag UID on success, or undefined if the node
 * does not support tags (e.g., gateway nodes return 404).
 */
export async function tryCreateTag(bee: Bee): Promise<number | undefined> {
  try {
    const tagResponse = await bee.createTag()
    return tagResponse.uid
  } catch {
    console.warn(
      "[tryCreateTag] Tag creation failed — node may not support tags, proceeding without tag",
    )
    return undefined
  }
}
