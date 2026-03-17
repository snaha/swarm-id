<!--
  Polycon — polygon-based identicon generator.

  Based on Polycon by Christian Montoya (https://github.com/Montoya/polycon).
  Original algorithm: SDBM hash → 2×2 grid of triangles/squares with color pairs.
  Adapted here as an inline SVG Svelte component with a custom brand color palette.
-->
<script lang="ts">
  interface Props {
    value: string
    size?: number
    class?: string
  }

  let { value, size = 40, class: className }: Props = $props()

  const NEAR_WHITE = '#FCFCFC'
  const NEAR_BLACK = '#131416'

  // Brand colors: [light, main, dark]
  const ORANGE = ['#FFE0CC', '#DD7200', '#401F00'] as const
  const BLUE = ['#99CCFF', '#0082FB', '#003366'] as const
  const GREEN = ['#99E6B3', '#00C853', '#004D1F'] as const
  const PURPLE = ['#E1BEE7', '#9C27B0', '#4A148C'] as const

  const BRANDS = [ORANGE, BLUE, GREEN, PURPLE] as const

  // Build color pairs: [background, foreground]
  const COLOR_PAIRS: [string, string][] = []

  // Neutral pairs: brand main with near-white/near-black (both directions)
  for (const brand of BRANDS) {
    COLOR_PAIRS.push([brand[1], NEAR_WHITE])
    COLOR_PAIRS.push([brand[1], NEAR_BLACK])
    COLOR_PAIRS.push([NEAR_WHITE, brand[1]])
    COLOR_PAIRS.push([NEAR_BLACK, brand[1]])
  }

  // Tonal pairs: light/dark with main (both directions)
  for (const brand of BRANDS) {
    COLOR_PAIRS.push([brand[0], brand[1]])
    COLOR_PAIRS.push([brand[2], brand[1]])
    COLOR_PAIRS.push([brand[1], brand[0]])
    COLOR_PAIRS.push([brand[1], brand[2]])
    COLOR_PAIRS.push([brand[0], brand[2]])
    COLOR_PAIRS.push([brand[2], brand[0]])
  }

  // Complementary pairs: cross-brand light/dark combinations
  for (let i = 0; i < BRANDS.length; i++) {
    const next = BRANDS[(i + 1) % BRANDS.length]
    COLOR_PAIRS.push([BRANDS[i][0], next[2]])
    COLOR_PAIRS.push([next[2], BRANDS[i][0]])
  }

  const GRID = 2
  const MARGIN_RATIO = 0.25

  // SDBM hash algorithm
  function sdbmHash(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + (hash << 6) + (hash << 16) - hash
    }
    return hash
  }

  function generateSvg(seed: string, svgSize: number): string {
    const str = seed.length < 6 ? seed.padEnd(6, ' ') : seed
    const hash = sdbmHash(str)

    const colorPairIndex = Math.abs(hash) % COLOR_PAIRS.length
    const [bgColor, fgColor] = COLOR_PAIRS[colorPairIndex]

    const margin = svgSize * MARGIN_RATIO
    const innerSize = svgSize - 2 * margin
    const cellSize = innerSize / GRID

    let pathData = ''

    const filledGrid = Array.from({ length: GRID }, () => Array<boolean>(GRID).fill(false))

    const startX = Math.floor(GRID / 2)
    const startY = Math.floor(GRID / 2)
    const stack: [number, number][] = [[startX, startY]]
    filledGrid[startX][startY] = true

    while (stack.length > 0) {
      const [x, y] = stack.pop()!
      const cellHash = Math.abs(hash >> (x * 3 + y * 5)) & 15

      const neighbors: [number, number][] = []
      const directions: [number, number][] = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ]

      for (const [dx, dy] of directions) {
        const newX = x + dx
        const newY = y + dy
        if (newX >= 0 && newX < GRID && newY >= 0 && newY < GRID && !filledGrid[newX][newY]) {
          neighbors.push([newX, newY])
        }
      }

      while (neighbors.length > 0) {
        const idx = Math.abs(cellHash + neighbors.length) % neighbors.length
        const [nextX, nextY] = neighbors.splice(idx, 1)[0]
        stack.push([nextX, nextY])
        filledGrid[nextX][nextY] = true
      }

      const rotation = (cellHash % 4) * 90
      const isSquare = cellHash % 5 === 0

      const cx = margin + x * cellSize
      const cy = margin + y * cellSize

      if (isSquare) {
        pathData += `M${cx},${cy} h${cellSize} v${cellSize} h-${cellSize}z `
      } else if (rotation === 0) {
        pathData += `M${cx},${cy} h${cellSize} v${cellSize}z `
      } else if (rotation === 90) {
        pathData += `M${cx + cellSize},${cy} v${cellSize} h-${cellSize}z `
      } else if (rotation === 180) {
        pathData += `M${cx + cellSize},${cy + cellSize} h-${cellSize} v-${cellSize}z `
      } else {
        pathData += `M${cx},${cy + cellSize} v-${cellSize} h${cellSize}z `
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}"><rect width="${svgSize}" height="${svgSize}" fill="${bgColor}"/><path d="${pathData}" fill="${fgColor}"/></svg>`
  }

  const svg = $derived(generateSvg(value, size))
</script>

<div class="polycon {className ?? ''}" style="width: {size}px; height: {size}px;">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- SVG is generated internally from deterministic hash, not user input -->
  {@html svg}
</div>

<style>
  .polycon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
    flex-shrink: 0;
  }
</style>
