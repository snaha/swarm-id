// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import {
  HOUR,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_SOURCE_IDLE_MAX_MS,
} from "./constants"
import { MAX_TIMER_DELAY_MS } from "./promise"
import {
  downloadReaderIdleTimeout,
  uploadSourceIdleTimeout,
} from "./stream-deadline"

describe("uploadSourceIdleTimeout", () => {
  it("is the idle default without a timeout, or with a shorter one", () => {
    expect(uploadSourceIdleTimeout(undefined)).toBe(STREAM_IDLE_TIMEOUT_MS)
    expect(uploadSourceIdleTimeout(1)).toBe(STREAM_IDLE_TIMEOUT_MS)
  })

  it("follows a longer timeout up to the ceiling", () => {
    const longer = STREAM_IDLE_TIMEOUT_MS * 2
    expect(uploadSourceIdleTimeout(longer)).toBe(longer)
  })

  it("stops at the ceiling whatever timeout asks", () => {
    expect(uploadSourceIdleTimeout(HOUR)).toBe(STREAM_SOURCE_IDLE_MAX_MS)
    expect(uploadSourceIdleTimeout(MAX_TIMER_DELAY_MS * 2)).toBe(
      STREAM_SOURCE_IDLE_MAX_MS,
    )
  })
})

describe("downloadReaderIdleTimeout", () => {
  it("is the idle default without a timeout, or with a shorter one", () => {
    expect(downloadReaderIdleTimeout(undefined)).toBe(STREAM_IDLE_TIMEOUT_MS)
    expect(downloadReaderIdleTimeout(1)).toBe(STREAM_IDLE_TIMEOUT_MS)
  })

  it("follows a timeout past the upload ceiling, up to the timer ceiling", () => {
    expect(downloadReaderIdleTimeout(HOUR)).toBe(HOUR)
    expect(downloadReaderIdleTimeout(MAX_TIMER_DELAY_MS * 2)).toBe(
      MAX_TIMER_DELAY_MS,
    )
  })
})
