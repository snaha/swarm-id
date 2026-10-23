// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { DEFAULT_SESSION_DURATION, appSessionDuration } from "./constants"

// The app's own session length (#885) over the account's over the default:
// one rule for the connect popup and a partitioned proxy alike.
describe("appSessionDuration", () => {
  it("prefers the app's own length, then the account's, then the default", () => {
    expect(appSessionDuration(undefined, undefined)).toBe(
      DEFAULT_SESSION_DURATION,
    )
    expect(appSessionDuration({ appSessionDuration: 5 }, {})).toBe(5)
    expect(
      appSessionDuration({ appSessionDuration: 5 }, { sessionDuration: 7 }),
    ).toBe(7)
    expect(appSessionDuration(undefined, { sessionDuration: 7 })).toBe(7)
  })
})
