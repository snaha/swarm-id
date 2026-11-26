// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { RollingValueProvider } from "./rolling-value-provider"

describe("RollingValueProvider", () => {
  it("starts on the first value and keeps it until asked to move on", () => {
    const provider = new RollingValueProvider(["a", "b"])
    expect(provider.current()).toBe("a")
    expect(provider.current()).toBe("a")
  })

  it("moves to the next value and wraps past the last", () => {
    const provider = new RollingValueProvider(["a", "b", "c"])
    expect(provider.next()).toBe("b")
    expect(provider.next()).toBe("c")
    expect(provider.next()).toBe("a")
    expect(provider.current()).toBe("a")
  })
})
