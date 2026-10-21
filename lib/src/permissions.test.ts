// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { effectivePermissions } from "./permissions"

describe("effectivePermissions", () => {
  it("is on by default", () => {
    expect(effectivePermissions(undefined, undefined)).toEqual({
      dataSharing: true,
      writeAccess: true,
    })
  })

  it("follows the account defaults when the app has no say", () => {
    expect(effectivePermissions({}, { dataSharing: false })).toEqual({
      dataSharing: false,
      writeAccess: false,
    })
    expect(effectivePermissions({}, { writeAccess: false })).toEqual({
      dataSharing: true,
      writeAccess: false,
    })
  })

  it("lets a pinned app value override the account default either way", () => {
    expect(
      effectivePermissions({ dataSharing: true }, { dataSharing: false }),
    ).toEqual({ dataSharing: true, writeAccess: true })
    expect(
      effectivePermissions(
        { writeAccess: false },
        { dataSharing: true, writeAccess: true },
      ),
    ).toEqual({ dataSharing: true, writeAccess: false })
  })

  it("never grants write access without data sharing", () => {
    expect(
      effectivePermissions({ dataSharing: false, writeAccess: true }, {}),
    ).toEqual({ dataSharing: false, writeAccess: false })
  })
})
