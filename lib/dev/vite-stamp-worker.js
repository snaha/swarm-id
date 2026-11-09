// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vite plugin providing the `virtual:stamp-worker-code` module for dev.
 *
 * In production the lib is consumed as the rollup bundle, where
 * `embedStampWorker()` (lib/rollup.config.js) embeds the pre-built worker
 * IIFE. In dev the apps alias `@snaha/swarm-id` to `lib/src/index.ts`
 * (see #347), so the source-level `virtual:stamp-worker-code` import in
 * `src/proxy/stamp-worker-pool.ts` reaches Vite — this plugin answers it by
 * bundling `src/proxy/stamp-worker.ts` to an IIFE string with esbuild,
 * mirroring the rollup phase-1 output.
 *
 * The plugin is id-gated: registering it unconditionally is safe because the
 * virtual id is only ever imported when the dev source alias is active.
 * Every esbuild input is registered as a watch file so editing the worker
 * (or anything it imports) invalidates the virtual module too.
 */

import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const VIRTUAL_ID = "virtual:stamp-worker-code"
const RESOLVED_ID = "\0" + VIRTUAL_ID

const WORKER_ENTRY = fileURLToPath(
  new URL("../src/proxy/stamp-worker.ts", import.meta.url),
)

export function stampWorkerDev() {
  return {
    name: "swarm-id:dev-stamp-worker",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
    },
    async load(id) {
      if (id !== RESOLVED_ID) return
      const result = await build({
        entryPoints: [WORKER_ENTRY],
        bundle: true,
        format: "iife",
        platform: "browser",
        write: false,
        metafile: true,
      })
      for (const input of Object.keys(result.metafile.inputs)) {
        this.addWatchFile(input)
      }
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`
    },
  }
}
