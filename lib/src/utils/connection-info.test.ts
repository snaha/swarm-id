// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { generatedAvatar } from "./avatar"
import { connectionInfoEqual } from "./connection-info"
import type { ConnectionInfo } from "../types"

const IDENTITY = {
  id: "0x1111111111111111111111111111111111111111",
  name: "alice",
  address: "0x1111111111111111111111111111111111111111",
  publicKey: "0x02" + "ab".repeat(32),
  avatar: generatedAvatar("0x1111111111111111111111111111111111111111"),
}

const APP_KEY = {
  address: "0x2222222222222222222222222222222222222222",
  publicKey: "0x03" + "cd".repeat(32),
}

const BASE: ConnectionInfo = {
  canUpload: true,
  uploadMode: "user-stamp",
  identity: IDENTITY,
  appKey: APP_KEY,
}

describe("connectionInfoEqual", () => {
  it("returns false when the previous snapshot is undefined", () => {
    expect(connectionInfoEqual(undefined, BASE)).toBe(false)
  })

  it("returns true for identical snapshots", () => {
    expect(connectionInfoEqual({ ...BASE }, { ...BASE })).toBe(true)
  })

  it("returns false when canUpload differs", () => {
    expect(
      connectionInfoEqual({ ...BASE }, { ...BASE, canUpload: false }),
    ).toBe(false)
  })

  it("returns false when uploadMode differs", () => {
    expect(
      connectionInfoEqual({ ...BASE }, { ...BASE, uploadMode: "subsidised" }),
    ).toBe(false)
  })

  it("returns false when identity id differs", () => {
    expect(
      connectionInfoEqual(
        { ...BASE },
        { ...BASE, identity: { ...IDENTITY, id: "0xff" } },
      ),
    ).toBe(false)
  })

  it("returns false when identity name differs (rename case)", () => {
    expect(
      connectionInfoEqual(
        { ...BASE },
        { ...BASE, identity: { ...IDENTITY, name: "renamed" } },
      ),
    ).toBe(false)
  })

  it("returns false when appKey differs", () => {
    expect(
      connectionInfoEqual(
        { ...BASE },
        {
          ...BASE,
          appKey: { ...APP_KEY, publicKey: "0x03" + "ff".repeat(32) },
        },
      ),
    ).toBe(false)
  })

  it("treats `storagePartitioned: false` and `undefined` as equivalent", () => {
    const omitted: ConnectionInfo = { ...BASE }
    const explicit: ConnectionInfo = { ...BASE, storagePartitioned: false }
    expect(connectionInfoEqual(omitted, explicit)).toBe(true)
    expect(connectionInfoEqual(explicit, omitted)).toBe(true)
  })

  it("returns false when storagePartitioned actually toggles to true", () => {
    expect(
      connectionInfoEqual({ ...BASE }, { ...BASE, storagePartitioned: true }),
    ).toBe(false)
  })

  it("returns false when one side has identity and the other doesn't", () => {
    expect(
      connectionInfoEqual(
        { ...BASE, identity: undefined },
        { ...BASE, identity: IDENTITY },
      ),
    ).toBe(false)
  })
})
