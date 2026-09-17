// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A file's path inside the folder it was picked with. `webkitdirectory` and a
 * dropped directory prefix every path with the folder's own name; that segment
 * goes, so `index.html` sits at the manifest root — the rule bee-js applies.
 */
export function collectionPath(
  file: Pick<File, "name" | "webkitRelativePath">,
): string {
  const relative = file.webkitRelativePath
  return relative ? relative.replace(/^[^/]*\//, "") : file.name
}
