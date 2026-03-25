import { describe, it, expect } from "vitest"
import { mergeDevices } from "./device-id"
import { createDevice, TEST_DEVICE_ID } from "../test-fixtures"

describe("mergeDevices", () => {
  it("should add a new device to an empty list", () => {
    const result = mergeDevices([], "new-device-id")

    expect(result).toHaveLength(1)
    expect(result[0].deviceId).toBe("new-device-id")
    expect(result[0].createdAt).toBeGreaterThan(0)
    expect(result[0].lastSignedInAt).toBe(result[0].createdAt)
  })

  it("should update lastSignedInAt for an existing device", () => {
    const existing = [createDevice({ lastSignedInAt: 1000 })]

    const result = mergeDevices(existing, TEST_DEVICE_ID)

    expect(result).toHaveLength(1)
    expect(result[0].deviceId).toBe(TEST_DEVICE_ID)
    expect(result[0].createdAt).toBe(1700000000000) // preserved
    expect(result[0].lastSignedInAt).toBeGreaterThan(1000)
  })

  it("should preserve other devices when adding a new one", () => {
    const existing = [createDevice()]

    const result = mergeDevices(existing, "second-device")

    expect(result).toHaveLength(2)
    expect(result[0].deviceId).toBe(TEST_DEVICE_ID)
    expect(result[1].deviceId).toBe("second-device")
  })

  it("should preserve other devices when updating an existing one", () => {
    const existing = [
      createDevice({ deviceId: "device-a" }),
      createDevice({ deviceId: "device-b", lastSignedInAt: 1000 }),
    ]

    const result = mergeDevices(existing, "device-b")

    expect(result).toHaveLength(2)
    expect(result[0].deviceId).toBe("device-a")
    expect(result[0].lastSignedInAt).toBe(1700000000000) // unchanged
    expect(result[1].deviceId).toBe("device-b")
    expect(result[1].lastSignedInAt).toBeGreaterThan(1000)
  })
})
