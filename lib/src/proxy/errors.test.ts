// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What crosses the bridge for each kind of failure (#761): a stable `code`,
 * and where Bee or the gateway answered, its status and message. The message
 * text is untouched, so `error.message` reads as before.
 */

import { describe, it, expect } from "vitest"
import { BeeResponseError } from "@ethersphere/bee-js"
import { z } from "zod"
import { toWireError } from "./errors"
import { SwarmIdError } from "../errors"
import { TimeoutError } from "../utils/promise"
import { PartitionContendedError } from "../sync/batch-write-coordinator"
import { PartitionLeaseLostError } from "../utils/batch-utilization"
import { SocUploadError } from "./upload"

describe("toWireError", () => {
  it("keeps the proxy's own refusal as it was thrown", () => {
    const refusal = new SwarmIdError("upload-unavailable", "drive expired", {
      reason: "stamp-expired",
    })
    expect(toWireError(refusal, "Upload failed")).toEqual({
      error: "drive expired",
      code: "upload-unavailable",
      reason: "stamp-expired",
    })
  })

  it("carries Bee's status, message and URL for a rejected request", () => {
    const rejected = new BeeResponseError(
      "POST",
      "http://bee.example/chunks",
      "Request failed with status code 402",
      { code: 402, message: "batch not usable" },
      402,
      "Payment Required",
    )
    expect(toWireError(rejected, "Upload failed")).toEqual({
      error: "Request failed with status code 402",
      code: "bee-rejected",
      status: 402,
      beeMessage: "batch not usable",
      url: "/chunks",
    })
  })

  it("keeps the node's host out of the path it sends", () => {
    const rejected = new BeeResponseError(
      "GET",
      "http://192.168.1.20:1633/chunks/aa",
      "Request failed with status code 404",
      undefined,
      404,
    )
    expect(toWireError(rejected, "x").url).toBe("/chunks/aa")
  })

  it("carries the subsidised gateway's status for a refused SOC", () => {
    const refused = new SocUploadError(400, "Bad Request", "invalid stamp")
    const wire = toWireError(refused, "SOC upload failed")
    expect(wire).toMatchObject({
      code: "bee-rejected",
      status: 400,
      beeMessage: "invalid stamp",
    })
  })

  it("reads a fetch with no response as the network", () => {
    expect(
      toWireError(new TypeError("Failed to fetch"), "Upload failed"),
    ).toEqual({ error: "Failed to fetch", code: "network" })
  })

  it("names the lease outcomes and a deadline", () => {
    expect(toWireError(new PartitionContendedError(), "x").code).toBe(
      "partition-contended",
    )
    expect(toWireError(new PartitionLeaseLostError(), "x").code).toBe(
      "lease-lost",
    )
    expect(toWireError(new TimeoutError("slow"), "x").code).toBe("timeout")
  })

  it("reads a schema failure as an invalid request", () => {
    const parse = z.object({ a: z.string() }).safeParse({})
    expect(parse.success).toBe(false)
    if (!parse.success) {
      expect(toWireError(parse.error, "x").code).toBe("invalid-request")
    }
  })

  it("falls back to internal with the message, or the caller's fallback for a non-Error", () => {
    expect(toWireError(new Error("boom"), "Upload failed")).toEqual({
      error: "boom",
      code: "internal",
    })
    expect(toWireError("boom", "Upload failed")).toEqual({
      error: "Upload failed",
      code: "internal",
    })
  })
})
