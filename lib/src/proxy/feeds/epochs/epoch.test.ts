/**
 * Unit tests for epoch structure and tree navigation
 */

import { describe, it, expect } from "vitest"
import { EpochIndex, lca, next, MAX_LEVEL } from "./epoch"

describe("EpochIndex", () => {
  describe("constructor", () => {
    it("should create epoch with valid level", () => {
      const epoch = new EpochIndex(0n, 0)
      expect(epoch.start).toBe(0n)
      expect(epoch.level).toBe(0)
    })

    it("should throw error for negative level", () => {
      expect(() => new EpochIndex(0n, -1)).toThrow()
    })

    it("should throw error for level > MAX_LEVEL", () => {
      expect(() => new EpochIndex(0n, MAX_LEVEL + 1)).toThrow()
    })
  })

  describe("length", () => {
    it("should return 1 for level 0", () => {
      const epoch = new EpochIndex(0n, 0)
      expect(epoch.length()).toBe(1n)
    })

    it("should return 2^level", () => {
      expect(new EpochIndex(0n, 1).length()).toBe(2n)
      expect(new EpochIndex(0n, 2).length()).toBe(4n)
      expect(new EpochIndex(0n, 3).length()).toBe(8n)
      expect(new EpochIndex(0n, 10).length()).toBe(1024n)
    })

    it("should handle MAX_LEVEL", () => {
      const epoch = new EpochIndex(0n, MAX_LEVEL)
      expect(epoch.length()).toBe(1n << BigInt(MAX_LEVEL))
    })
  })

  describe("parent", () => {
    it("should calculate parent epoch", () => {
      const child = new EpochIndex(0n, 0)
      const parent = child.parent()
      expect(parent.level).toBe(1)
      expect(parent.start).toBe(0n)
    })

    it("should normalize start to parent boundary", () => {
      const child = new EpochIndex(3n, 0)
      const parent = child.parent()
      expect(parent.level).toBe(1)
      expect(parent.start).toBe(2n) // 3/2*2 = 2
    })

    it("should handle multiple levels", () => {
      let epoch = new EpochIndex(0n, 0)
      epoch = epoch.parent()
      expect(epoch.level).toBe(1)
      epoch = epoch.parent()
      expect(epoch.level).toBe(2)
      epoch = epoch.parent()
      expect(epoch.level).toBe(3)
    })
  })

  describe("left", () => {
    it("should return left sibling at same level", () => {
      const epoch = new EpochIndex(2n, 1)
      const left = epoch.left()
      expect(left.level).toBe(1) // Same level
      expect(left.start).toBe(0n) // 2 - 2 = 0
    })

    it("should calculate left sibling correctly", () => {
      const epoch = new EpochIndex(8n, 2)
      const left = epoch.left()
      expect(left.level).toBe(2) // Same level
      expect(left.start).toBe(4n) // 8 - 4 = 4
    })
  })

  describe("childAt", () => {
    it("should return left child when at is in left half", () => {
      const parent = new EpochIndex(0n, 2)
      const child = parent.childAt(1n)
      expect(child.level).toBe(1)
      expect(child.start).toBe(0n)
    })

    it("should return right child when at is in right half", () => {
      const parent = new EpochIndex(0n, 2)
      const child = parent.childAt(3n)
      expect(child.level).toBe(1)
      expect(child.start).toBe(2n)
    })

    it("should handle multiple descents", () => {
      let epoch = new EpochIndex(0n, 3)
      epoch = epoch.childAt(5n)
      expect(epoch.level).toBe(2)
      expect(epoch.start).toBe(4n)
      epoch = epoch.childAt(5n)
      expect(epoch.level).toBe(1)
      expect(epoch.start).toBe(4n)
      epoch = epoch.childAt(5n)
      expect(epoch.level).toBe(0)
      expect(epoch.start).toBe(5n)
    })
  })

  describe("isLeft", () => {
    it("should return true for left child", () => {
      const parent = new EpochIndex(0n, 2)
      const left = parent.childAt(0n)
      expect(left.isLeft()).toBe(true)
    })

    it("should return false for right child", () => {
      const parent = new EpochIndex(0n, 2)
      const right = parent.childAt(3n)
      expect(right.isLeft()).toBe(false)
    })

    it("should handle level 0", () => {
      expect(new EpochIndex(0n, 0).isLeft()).toBe(true)
      expect(new EpochIndex(1n, 0).isLeft()).toBe(false)
      expect(new EpochIndex(2n, 0).isLeft()).toBe(true)
      expect(new EpochIndex(3n, 0).isLeft()).toBe(false)
    })
  })

  describe("marshalBinary", () => {
    it("should produce 32-byte hash", async () => {
      const epoch = new EpochIndex(0n, 0)
      const hash = await epoch.marshalBinary()
      expect(hash.length).toBe(32)
    })

    it("should produce different hashes for different epochs", async () => {
      const epoch1 = new EpochIndex(0n, 0)
      const epoch2 = new EpochIndex(1n, 0)
      const epoch3 = new EpochIndex(0n, 1)

      const hash1 = await epoch1.marshalBinary()
      const hash2 = await epoch2.marshalBinary()
      const hash3 = await epoch3.marshalBinary()

      expect(hash1).not.toEqual(hash2)
      expect(hash1).not.toEqual(hash3)
      expect(hash2).not.toEqual(hash3)
    })

    it("should produce same hash for same epoch", async () => {
      const epoch1 = new EpochIndex(42n, 10)
      const epoch2 = new EpochIndex(42n, 10)

      const hash1 = await epoch1.marshalBinary()
      const hash2 = await epoch2.marshalBinary()

      expect(hash1).toEqual(hash2)
    })
  })

  describe("toString", () => {
    it("should format as start/level", () => {
      expect(new EpochIndex(0n, 0).toString()).toBe("0/0")
      expect(new EpochIndex(42n, 10).toString()).toBe("42/10")
      expect(new EpochIndex(1000n, 20).toString()).toBe("1000/20")
    })
  })
})

describe("lca (Lowest Common Ancestor)", () => {
  it("should return top epoch when after is 0", () => {
    const result = lca(100n, 0n)
    expect(result.level).toBe(MAX_LEVEL)
    expect(result.start).toBe(0n)
  })

  it("should return level 1 for adjacent timestamps", () => {
    const result = lca(5n, 4n)
    expect(result.level).toBe(1) // Spans [4, 6), contains both 4 and 5
    expect(result.start).toBe(4n)
  })

  it("should return level 2 for timestamps 2 apart", () => {
    const result = lca(6n, 4n)
    expect(result.level).toBe(2) // Spans [4, 8), contains both 4 and 6
    expect(result.start).toBe(4n)
  })

  it("should return level 4 for timestamps 4 apart", () => {
    const result = lca(8n, 4n)
    expect(result.level).toBe(4) // Spans [0, 16), contains both 4 and 8
    expect(result.start).toBe(0n)
  })

  it("should handle same timestamp", () => {
    const result = lca(5n, 5n)
    expect(result.level).toBe(0)
    expect(result.start).toBe(5n)
  })

  it("should handle large gaps", () => {
    const result = lca(1000n, 100n)
    expect(result.level).toBeGreaterThan(8) // 2^9 = 512, 2^10 = 1024
  })
})

describe("next", () => {
  it("should return top epoch for first update", () => {
    const result = next(undefined, 0n, 100n)
    expect(result.level).toBe(MAX_LEVEL)
    expect(result.start).toBe(0n)
  })

  it("should calculate next epoch within same parent", () => {
    // Last update was at time 0 in epoch (0, 2)
    const last = new EpochIndex(0n, 2)
    // New update at time 1, which is within [0, 4)
    const result = next(last, 0n, 1n)
    // Should descend to child at time 1
    expect(result.start).toBe(0n)
    expect(result.level).toBe(1)
  })

  it("should handle updates spanning different epochs", () => {
    // Last update was at time 100 in some epoch
    const last = new EpochIndex(100n, 0)
    // New update at time 200
    const result = next(last, 100n, 200n)
    // Should use lca(200, 100) and descend
    expect(result.start).toBeLessThanOrEqual(200n)
    expect(result.level).toBeGreaterThanOrEqual(0)
  })
})
