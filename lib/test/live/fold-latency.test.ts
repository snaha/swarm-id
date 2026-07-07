// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fold-latency benchmark for #400: measures what `foldAccountFromSwarm` costs
 * against a real gateway for a small (2-device) account — wall-clock time AND
 * Bee read count per fold — the product's page-load / recurring (#389) fold.
 *
 * Publishes a steady-state 2-device account, then runs 10 sequential folds and
 * prints a per-fold table + summary stats. Asserts only convergence (both
 * devices in every fold); the timings are the deliverable, not an assertion —
 * gateway variance would make a hard latency bound flaky.
 *
 * Caveat when comparing runs: the gateway negative-caches absent chunks (~50s),
 * so back-to-back folds resolve absent-slot probes faster than the product's
 * minutes-apart folds. Both before/after runs share that bias.
 *
 * Opt-in — skips unless a `.env` configures BATCH_ID/SIGNER_KEY (see README).
 */

import { describe, it, expect, beforeAll } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { publishDeviceState } from "../../src/sync/device-state"
import { foldAccountFromSwarm } from "../../src/sync/fold-account-from-swarm"
import {
  liveEnv,
  createContext,
  deriveAgentKeys,
  deviceId,
  makeDevice,
  makeView,
  foldUntil,
  delay,
  type LiveContext,
} from "./env"

const FOLD_RUNS = 10

/**
 * Wrap a Bee so every chunk/SOC read increments `reads` — `downloadChunk` and
 * `makeSOCReader().download` are the only two read paths the fold uses
 * (roster SOCs, epoch-finder probes, and `downloadDataWithChunkAPI` blobs).
 */
function withReadCounter(bee: Bee): { bee: Bee; counter: { reads: number } } {
  const counter = { reads: 0 }
  const proxied = new Proxy(bee, {
    get(target, prop) {
      if (prop === "downloadChunk") {
        return (...args: Parameters<Bee["downloadChunk"]>) => {
          counter.reads++
          return target.downloadChunk(...args)
        }
      }
      if (prop === "makeSOCReader") {
        return (...args: Parameters<Bee["makeSOCReader"]>) => {
          const reader = target.makeSOCReader(...args)
          return {
            ...reader,
            download: (...a: Parameters<(typeof reader)["download"]>) => {
              counter.reads++
              return reader.download(...a)
            },
          }
        }
      }
      // Bind methods to the real instance so bee-js internals (private state)
      // keep working through the proxy.
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { bee: proxied, counter }
}

describe.skipIf(!liveEnv.configured)("live — fold latency (#400)", () => {
  let ctx: LiveContext
  let keys: Awaited<ReturnType<typeof deriveAgentKeys>>
  let DEVICE_A: string
  let DEVICE_B: string

  beforeAll(async () => {
    ctx = createContext()
    keys = await deriveAgentKeys()
    DEVICE_A = deviceId("device-a")
    DEVICE_B = deviceId("device-b")
    console.log(`account ${keys.accountId}  A=${DEVICE_A}  B=${DEVICE_B}`)
  })

  it("publishes a steady-state 2-device account", async () => {
    const pub = (
      device: ReturnType<typeof makeDevice>,
      view: ReturnType<typeof makeView>,
    ) =>
      publishDeviceState({
        bee: ctx.bee,
        accountId: keys.accountId,
        device,
        accountKey: keys.accountKey,
        owner: keys.owner,
        encryptionKey: keys.encryptionKey,
        view,
        target: ctx.target,
      })

    const sA = await pub(makeDevice(DEVICE_A, "Device A"), makeView())
    expect(sA.status).not.toBe("error")
    // Space the announces past the gateway's ~50s negative cache so B's roster
    // append sees A's entry (same reason as per-device-sync.test.ts).
    await delay(liveEnv.propDelayMs)
    const sB = await pub(makeDevice(DEVICE_B, "Device B"), makeView())
    expect(sB.status).not.toBe("error")

    const folded = await foldUntil(
      ctx.bee,
      keys.derivationKey,
      keys.accountId,
      (a) => a.devices.filter((d) => !d.removedAt).length === 2,
      "2 devices visible",
    )
    expect(folded, "steady state reached").toBeDefined()
  })

  it(`measures ${FOLD_RUNS} sequential folds (time + reads)`, async () => {
    const { bee, counter } = withReadCounter(ctx.bee)
    const times: number[] = []
    const rows: string[] = []

    for (let i = 0; i < FOLD_RUNS; i++) {
      counter.reads = 0
      const t0 = Date.now()
      const folded = await foldAccountFromSwarm({
        bee,
        derivationKey: keys.derivationKey,
        accountId: keys.accountId,
      })
      const ms = Date.now() - t0
      times.push(ms)
      rows.push(
        `  fold-${String(i + 1).padStart(2)}  ${String(ms).padStart(7)}ms` +
          `  reads=${String(counter.reads).padStart(3)}`,
      )
      expect(folded, `fold ${i + 1} returned a result`).toBeDefined()
      expect(folded!.devices).toHaveLength(2)
    }

    const sorted = [...times].sort((a, b) => a - b)
    const mean = Math.round(times.reduce((s, t) => s + t, 0) / times.length)
    const median = sorted[Math.floor(sorted.length / 2)]
    console.log(
      `\n  ⏱  fold latency (${FOLD_RUNS} runs, 2 devices, ${liveEnv.beeUrl}):\n` +
        rows.join("\n") +
        `\n  min=${sorted[0]}ms  median=${median}ms  mean=${mean}ms  max=${sorted[sorted.length - 1]}ms\n`,
    )
  })
})
