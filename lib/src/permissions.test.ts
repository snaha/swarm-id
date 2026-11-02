// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  GRANT_CLOCKS,
  SETTINGS_CLOCKS,
  effectivePermissions,
  overlayNewer,
  sharingDefault,
  stampClocks,
} from "./permissions"

describe("effectivePermissions", () => {
  it("is on by default", () => {
    expect(effectivePermissions(undefined, undefined)).toEqual({
      dataSharing: true,
      writeAccess: true,
      revealSecrets: false,
    })
    expect(sharingDefault(undefined, "writeAccess")).toBe(true)
  })

  it("follows the account defaults when the app has no say", () => {
    expect(effectivePermissions({}, { dataSharing: false })).toEqual({
      dataSharing: false,
      writeAccess: false,
      revealSecrets: false,
    })
    expect(effectivePermissions({}, { writeAccess: false })).toEqual({
      dataSharing: true,
      writeAccess: false,
      revealSecrets: false,
    })
  })

  it("lets a pinned app value override the account default either way", () => {
    expect(
      effectivePermissions({ dataSharing: true }, { dataSharing: false }),
    ).toEqual({ dataSharing: true, writeAccess: true, revealSecrets: false })
    expect(
      effectivePermissions(
        { writeAccess: false },
        { dataSharing: true, writeAccess: true },
      ),
    ).toEqual({ dataSharing: true, writeAccess: false, revealSecrets: false })
  })

  // #889: no account-wide default to follow — the app's own pin or nothing.
  it("grants key export only when pinned on the app", () => {
    expect(effectivePermissions({ revealSecrets: true }, {})).toMatchObject({
      revealSecrets: true,
    })
    expect(effectivePermissions({ revealSecrets: false }, {})).toMatchObject({
      revealSecrets: false,
    })
    expect(GRANT_CLOCKS.revealSecrets).toBe("revealSecretsAt")
  })

  it("never grants write access without data sharing", () => {
    expect(
      effectivePermissions({ dataSharing: false, writeAccess: true }, {}),
    ).toEqual({ dataSharing: false, writeAccess: false, revealSecrets: false })
  })
})

// Each switch rides its own last-writer-wins clock, on the account and on the
// app entry alike: an unrelated edit made on a stale copy must not take an
// "off" with it.
describe("per-field clocks", () => {
  it("stamp the clock of each field a patch names, present or cleared", () => {
    expect(
      stampClocks({ dataSharing: false, drives: undefined }, GRANT_CLOCKS, 7),
    ).toEqual({
      dataSharing: false,
      dataSharingAt: 7,
      drives: undefined,
      drivesAt: 7,
    })
    expect(stampClocks({ appSessionDuration: 5 }, SETTINGS_CLOCKS, 7)).toEqual({
      appSessionDuration: 5,
    })
  })

  it("overlay each field whose clock is newer on the loser, and nothing else", () => {
    const winner = {
      appSessionDuration: 5,
      dataSharing: true,
      writeAccess: true,
      writeAccessAt: 3,
    }
    const loser = {
      appSessionDuration: 1,
      dataSharing: false,
      dataSharingAt: 2,
      writeAccess: false,
      writeAccessAt: 1,
    }
    expect(overlayNewer(winner, loser, SETTINGS_CLOCKS)).toEqual({
      appSessionDuration: 5,
      dataSharing: false,
      dataSharingAt: 2,
      writeAccess: true,
      writeAccessAt: 3,
    })
  })
})
