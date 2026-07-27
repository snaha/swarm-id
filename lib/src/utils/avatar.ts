// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account avatars. Every account has a generated one derived from its id;
 * accounts that upload their own will report a different {@link Avatar.source}.
 *
 * The generator is Polycon by Christian Montoya
 * (https://github.com/Montoya/polycon). Original algorithm: SDBM hash → 2×2
 * grid of triangles/squares with color pairs. Adapted here with a custom brand
 * color palette.
 */

import type { Avatar } from "../types"

const NEAR_WHITE = "#FCFCFC"
const NEAR_BLACK = "#131416"

/** Brand colors, each as [light, main, dark]. */
const ORANGE = ["#FFE0CC", "#DD7200", "#401F00"] as const
const BLUE = ["#99CCFF", "#0082FB", "#003366"] as const
const GREEN = ["#99E6B3", "#00C853", "#004D1F"] as const
const PURPLE = ["#E1BEE7", "#9C27B0", "#4A148C"] as const

const BRANDS = [ORANGE, BLUE, GREEN, PURPLE] as const

const LIGHT = 0
const MAIN = 1
const DARK = 2

/** [background, foreground] pairs the hash selects from. */
const COLOR_PAIRS: [string, string][] = []

// Neutral pairs: brand main with near-white/near-black (both directions)
for (const brand of BRANDS) {
  COLOR_PAIRS.push([brand[MAIN], NEAR_WHITE])
  COLOR_PAIRS.push([brand[MAIN], NEAR_BLACK])
  COLOR_PAIRS.push([NEAR_WHITE, brand[MAIN]])
  COLOR_PAIRS.push([NEAR_BLACK, brand[MAIN]])
}

// Tonal pairs: light/dark with main (both directions)
for (const brand of BRANDS) {
  COLOR_PAIRS.push([brand[LIGHT], brand[MAIN]])
  COLOR_PAIRS.push([brand[DARK], brand[MAIN]])
  COLOR_PAIRS.push([brand[MAIN], brand[LIGHT]])
  COLOR_PAIRS.push([brand[MAIN], brand[DARK]])
  COLOR_PAIRS.push([brand[LIGHT], brand[DARK]])
  COLOR_PAIRS.push([brand[DARK], brand[LIGHT]])
}

// Complementary pairs: cross-brand light/dark combinations
for (let i = 0; i < BRANDS.length; i++) {
  const next = BRANDS[(i + 1) % BRANDS.length]
  COLOR_PAIRS.push([BRANDS[i][LIGHT], next[DARK]])
  COLOR_PAIRS.push([next[DARK], BRANDS[i][LIGHT]])
}

/** Cells per side of the icon grid. */
const GRID = 2
/** Empty border around the grid, as a fraction of the icon size. */
const MARGIN_RATIO = 0.25
/** Default rendered size in pixels. */
const DEFAULT_SIZE = 40
/** Short seeds are space-padded to this length so they still spread the hash. */
const MIN_SEED_LENGTH = 6

const SDBM_SHIFT_LOW = 6
const SDBM_SHIFT_HIGH = 16

/** Per-cell hash derivation: shift the seed hash by these per-axis weights. */
const CELL_SHIFT_X = 3
const CELL_SHIFT_Y = 5
/** Keeps the per-cell hash in 0..15. */
const CELL_HASH_MASK = 15

const ROTATIONS = 4
const DEGREES_PER_ROTATION = 90
const QUARTER_TURN = 90
const HALF_TURN = 180
/** Every fifth per-cell hash fills the whole cell instead of a triangle. */
const SQUARE_EVERY = 5

const DIRECTIONS: readonly [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
]

function sdbmHash(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash =
      value.charCodeAt(i) +
      (hash << SDBM_SHIFT_LOW) +
      (hash << SDBM_SHIFT_HIGH) -
      hash
  }
  return hash
}

/**
 * Render an account's generated avatar as a standalone SVG string.
 *
 * The same seed always yields the same image, so a dApp passing the identity
 * id from `ConnectionInfo` renders exactly the avatar Swarm ID shows for that
 * account. Prefer `SwarmIdClient.getAvatar()`, which falls back to this only
 * while the account has no avatar of its own.
 *
 * @param seed - Value the avatar is derived from (e.g. `connectionInfo.identity.id`)
 * @param size - Width and height in pixels
 */
export function generatedAvatarSvg(seed: string, size = DEFAULT_SIZE): string {
  const padded =
    seed.length < MIN_SEED_LENGTH ? seed.padEnd(MIN_SEED_LENGTH, " ") : seed
  const hash = sdbmHash(padded)

  const [background, foreground] =
    COLOR_PAIRS[Math.abs(hash) % COLOR_PAIRS.length]

  const margin = size * MARGIN_RATIO
  const cellSize = (size - 2 * margin) / GRID

  const filled = Array.from({ length: GRID }, () =>
    Array<boolean>(GRID).fill(false),
  )
  const start = Math.floor(GRID / 2)
  const stack: [number, number][] = [[start, start]]
  filled[start][start] = true

  let pathData = ""

  for (let cell = stack.pop(); cell !== undefined; cell = stack.pop()) {
    const [x, y] = cell
    const cellHash =
      Math.abs(hash >> (x * CELL_SHIFT_X + y * CELL_SHIFT_Y)) & CELL_HASH_MASK

    const neighbors: [number, number][] = []
    for (const [dx, dy] of DIRECTIONS) {
      const nextX = x + dx
      const nextY = y + dy
      if (
        nextX >= 0 &&
        nextX < GRID &&
        nextY >= 0 &&
        nextY < GRID &&
        !filled[nextX][nextY]
      ) {
        neighbors.push([nextX, nextY])
      }
    }

    while (neighbors.length > 0) {
      const index = Math.abs(cellHash + neighbors.length) % neighbors.length
      const [nextX, nextY] = neighbors.splice(index, 1)[0]
      stack.push([nextX, nextY])
      filled[nextX][nextY] = true
    }

    const rotation = (cellHash % ROTATIONS) * DEGREES_PER_ROTATION
    const isSquare = cellHash % SQUARE_EVERY === 0

    const cx = margin + x * cellSize
    const cy = margin + y * cellSize

    if (isSquare) {
      pathData += `M${cx},${cy} h${cellSize} v${cellSize} h-${cellSize}z `
    } else if (rotation === 0) {
      pathData += `M${cx},${cy} h${cellSize} v${cellSize}z `
    } else if (rotation === QUARTER_TURN) {
      pathData += `M${cx + cellSize},${cy} v${cellSize} h-${cellSize}z `
    } else if (rotation === HALF_TURN) {
      pathData += `M${cx + cellSize},${cy + cellSize} h-${cellSize} v-${cellSize}z `
    } else {
      pathData += `M${cx},${cy + cellSize} v-${cellSize} h${cellSize}z `
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${background}"/><path d="${pathData}" fill="${foreground}"/></svg>`
}

/**
 * The generated avatar for `seed` as a renderable {@link Avatar}.
 *
 * @param seed - Value the avatar is derived from (e.g. `connectionInfo.identity.id`)
 * @param size - Width and height in pixels
 */
export function generatedAvatar(seed: string, size = DEFAULT_SIZE): Avatar {
  const svg = generatedAvatarSvg(seed, size)
  return {
    source: "generated",
    // Percent-encoded rather than base64: the markup is ASCII, and this keeps
    // the URL readable in devtools.
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  }
}
