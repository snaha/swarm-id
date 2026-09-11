// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs"
import typescript from "@rollup/plugin-typescript"
import resolve from "@rollup/plugin-node-resolve"
import commonjs from "@rollup/plugin-commonjs"
import terser from "@rollup/plugin-terser"
import json from "@rollup/plugin-json"
import { transform as esbuildTransform } from "esbuild"

const production = !process.env.ROLLUP_WATCH

// Shared TypeScript plugin configuration
const createTypeScriptPlugin = (options = {}) =>
  typescript({
    tsconfig: "./tsconfig.json",
    noEmitOnError: true,
    ...options,
  })

// Warning filter to suppress noisy third-party warnings
const onwarn = (warning, warn) => {
  // Skip circular dependency warnings from node_modules or external packages (bee-js, zod, etc.)
  if (
    warning.code === "CIRCULAR_DEPENDENCY" &&
    warning.ids?.some(
      (id) =>
        id.includes("node_modules") ||
        id.includes("/bee-js/") ||
        id.includes("/zod/"),
    )
  ) {
    return
  }
  // Skip missing export warnings for Node.js built-ins
  if (
    warning.code === "MISSING_EXPORT" &&
    warning.exporter?.includes("node-resolve:empty")
  ) {
    return
  }
  // Show all other warnings
  warn(warning)
}

// Shared node-resolve configuration (browser-only, skip Node.js built-ins)
const resolvePlugin = () =>
  resolve({
    browser: true,
    preferBuiltins: false,
    skip: [
      "tty",
      "util",
      "os",
      "stream",
      "path",
      "http",
      "https",
      "url",
      "fs",
      "assert",
      "zlib",
      "events",
      "net",
      "tls",
      "crypto",
      "buffer",
    ],
  })

/**
 * Virtual module plugin that embeds the built stamp worker IIFE as a string.
 * The main bundle imports `virtual:stamp-worker-code` to get the worker source.
 */
function embedStampWorker() {
  const VIRTUAL_ID = "virtual:stamp-worker-code"
  return {
    name: "embed-stamp-worker",
    resolveId(id) {
      if (id === VIRTUAL_ID) return "\0" + VIRTUAL_ID
    },
    load(id) {
      if (id === "\0" + VIRTUAL_ID) {
        const code = readFileSync("./dist/stamp-worker.iife.js", "utf-8")
        return `export default ${JSON.stringify(code)};`
      }
    },
  }
}

/**
 * The signaling wire schema (`@swarm-id/signaling/protocol`, #700) is a `.ts`
 * source reached through node_modules, and the TypeScript plugin emits nothing
 * for those — TS treats them as an external library. Strip its types here so
 * rollup can inline it like any other dependency.
 */
function transpileSignalingProtocol() {
  return {
    name: "transpile-signaling-protocol",
    async transform(code, id) {
      // Anything under signaling/src the bundle reaches: a rename or a second
      // shared module must not fail as a raw-TS parse error naming nothing.
      if (!/\/signaling\/src\/.*\.ts$/.test(id)) return null
      return esbuildTransform(code, { loader: "ts", sourcemap: true })
    },
  }
}

export default [
  // Phase 1: Build stamp worker as self-contained IIFE
  // This runs first — the output is embedded into the main bundle by Phase 2.
  {
    input: "src/proxy/stamp-worker.ts",
    output: {
      file: "dist/stamp-worker.iife.js",
      format: "iife",
    },
    onwarn,
    plugins: [
      resolvePlugin(),
      commonjs(),
      json(),
      createTypeScriptPlugin({
        declaration: false,
        declarationMap: false,
      }),
      production && terser(),
    ],
    external: [],
  },

  // Phase 2: Main ESM build (embeds worker code via virtual module)
  {
    input: "src/index.ts",
    output: {
      file: "dist/swarm-id.esm.js",
      format: "esm",
      sourcemap: true,
    },
    onwarn,
    plugins: [
      embedStampWorker(),
      transpileSignalingProtocol(),
      resolvePlugin(),
      commonjs(),
      json(),
      createTypeScriptPlugin({
        declaration: true,
        declarationDir: "./dist",
        outDir: "./dist",
      }),
      production && terser(),
    ],
    external: [],
  },
]
