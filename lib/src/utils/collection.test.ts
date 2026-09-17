// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { collectionPath } from "./collection"

describe("collectionPath", () => {
  it("drops the picked folder's own name from a webkitdirectory path", () => {
    expect(
      collectionPath({
        name: "app.js",
        webkitRelativePath: "site/assets/app.js",
      }),
    ).toBe("assets/app.js")
  })

  it("falls back to the file name when there is no relative path", () => {
    expect(collectionPath({ name: "a.txt", webkitRelativePath: "" })).toBe(
      "a.txt",
    )
  })
})
