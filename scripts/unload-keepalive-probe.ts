// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Does a `fetch` keepalive issued from `pagehide` reach the server after the
 * page is gone — when it needs a CORS preflight, as every Bee upload does
 * (`swarm-postage-stamp` is a custom header)? This is what the partition
 * release on unload relies on (#676, `PartitionLease.releaseOnUnload`).
 *
 * A page on :4601 fires the request at a logging "bee" on :4602 from
 * `pagehide`; the page is then closed, navigated away from, and reloaded, and
 * the log says which preflights and POSTs arrived. No Swarm involved.
 *
 *   pnpm --dir scripts install --ignore-workspace   # once; browsers via `pnpm exec playwright install`
 *   pnpm --dir scripts unload-keepalive-probe
 *   ONLY=firefox SIMPLE=1 pnpm --dir scripts unload-keepalive-probe   # one browser; no preflight
 *
 * Findings, 2026-09 (Playwright 1.57): Chromium and WebKit deliver every time.
 * Firefox drops the preflighted request on close and reload and keeps it on a
 * navigation; without the preflight (`SIMPLE=1`) it delivers every time.
 */

import http from 'node:http'
import { chromium, firefox, webkit, type BrowserType } from 'playwright'

const PAGE_PORT = 4601
const BEE_PORT = 4602
const SETTLE_MS = 1500
const BODY_BYTES = 4200
const STAMP_HEX_LENGTH = 226

const SIMPLE = process.env.SIMPLE === '1'
const ONLY = process.env.ONLY

interface Hit {
  method: string | undefined
  url: string | undefined
  stamp: string | undefined
  len: number
}
const log: Hit[] = []

const bee = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const stamp = req.headers['swarm-postage-stamp']
    log.push({
      method: req.method,
      url: req.url,
      stamp: Array.isArray(stamp) ? stamp[0] : stamp,
      len: Buffer.concat(chunks).length,
    })
    res.setHeader('access-control-allow-origin', `http://localhost:${PAGE_PORT}`)
    res.setHeader('access-control-allow-headers', 'content-type, swarm-postage-stamp')
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    res.statusCode = req.method === 'OPTIONS' ? 204 : 201
    res.end()
  })
})

const headers = SIMPLE
  ? '{}'
  : `{ "content-type": "application/octet-stream", "swarm-postage-stamp": "ab".repeat(${STAMP_HEX_LENGTH / 2}) }`
const page = `<!doctype html><title>keepalive</title><script>
  addEventListener("pagehide", () => {
    const tag = new URLSearchParams(location.search).get("tag")
    fetch("http://localhost:${BEE_PORT}/soc/" + tag, {
      method: "POST", keepalive: true, headers: ${headers},
      body: new Uint8Array(${BODY_BYTES}),
    }).catch(() => {})
  })
</script>ready`
const site = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(page)
})

await new Promise<void>((r) => bee.listen(BEE_PORT, r))
await new Promise<void>((r) => site.listen(PAGE_PORT, r))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: Record<string, string[]> = {}
const browsers: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]
for (const [name, type] of browsers) {
  if (ONLY && name !== ONLY) continue
  const browser = await type.launch()
  const key = `${name} ${browser.version()} ${SIMPLE ? 'simple' : 'preflight'}`
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  await p.goto(`http://localhost:${PAGE_PORT}/?tag=${name}-close`)
  await p.close() // tab close
  const p2 = await ctx.newPage()
  await p2.goto(`http://localhost:${PAGE_PORT}/?tag=${name}-navigate`)
  await p2.goto('about:blank') // navigate away
  await p2.goto(`http://localhost:${PAGE_PORT}/?tag=${name}-reload`)
  await p2.reload()
  await sleep(SETTLE_MS)
  await browser.close()
  results[key] = ['close', 'navigate', 'reload'].map((k) => {
    const suffix = `${name}-${k}`
    const post = log.find((e) => e.method === 'POST' && e.url?.endsWith(suffix))
    const preflights = log.filter((e) => e.method === 'OPTIONS' && e.url?.endsWith(suffix)).length
    const detail = post
      ? ` (stamp ok=${SIMPLE || post.stamp?.length === STAMP_HEX_LENGTH}, body=${post.len})`
      : ''
    return `${k}: preflight=${preflights} post=${post ? 1 : 0}${detail}`
  })
}
console.log(JSON.stringify(results, undefined, 2))
bee.close()
site.close()
