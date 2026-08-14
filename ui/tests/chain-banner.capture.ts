// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Screenshot capture for the dev page's chain banner and the faucet-backed
 * funding action, for PR review. NOT part of the test suite — the filename is
 * outside Playwright's default `*.test.ts` glob. Run explicitly:
 *
 *   pnpm dev:local   # repo root, for the chain
 *   pnpm exec playwright test --config=playwright.capture.config.ts
 *
 * PNGs land in `screenshots/`.
 *
 * The local-chain shots are real. The mainnet one is stubbed at the RPC
 * boundary rather than pointed at Gnosis: the banner is driven entirely by the
 * genesis hash, so answering with mainnet's is the whole of what makes it
 * mainnet — and a capture run should not depend on the internet.
 */
import { type Page, expect, test } from '@playwright/test'
import { DEV_FAUCET_ADDRESS } from '@swarm-id/multichain/dev'

import { completeCreateFlow } from './helpers'

const ANVIL_RPC_URL = 'http://localhost:9545'
const BEE_NODE_URL = 'http://localhost:1633/'
const OUT_DIR = 'screenshots'
const ONCHAIN_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 2000
/** Viewport matching the designs' 1366×768 frames. */
const VIEWPORT = { width: 1366, height: 768 }

/** A host nothing resolves, so a missed stub fails loudly instead of leaking. */
const FAKE_MAINNET_RPC_URL = 'http://gnosis-mainnet.test/rpc'
const GNOSIS_CHAIN_ID_HEX = '0x64'
const GNOSIS_GENESIS_HASH = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return typeof ((await response.json()) as { result?: string }).result === 'string'
  } catch {
    return false
  }
}

const chainUp = await anvilReachable()

function seedSettings(page: Page, rpcUrl: string) {
  return page.addInitScript(
    ([rpc, bee]) => {
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: bee, gnosisRpcUrl: rpc }),
      )
    },
    [rpcUrl, BEE_NODE_URL],
  )
}

/** Answer only what the banner asks, as Gnosis mainnet would. */
async function stubMainnetRpc(page: Page) {
  await page.route(`${FAKE_MAINNET_RPC_URL}**`, async (route) => {
    const { method, id } = route.request().postDataJSON() as { method: string; id: number }
    const result =
      method === 'eth_chainId'
        ? GNOSIS_CHAIN_ID_HEX
        : method === 'eth_getBlockByNumber'
          ? { hash: GNOSIS_GENESIS_HASH }
          : undefined
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id, result }),
    })
  })
}

test.describe.configure({ mode: 'serial' })
test.skip(!chainUp, 'requires a local chain (pnpm dev:local)')

test('dev page banner on the local chain', async ({ page }) => {
  await page.setViewportSize(VIEWPORT)
  await seedSettings(page, ANVIL_RPC_URL)
  await page.goto('/dev')
  await expect(page.getByText(/Local dev chain, nothing here is real/)).toBeVisible()
  await page.screenshot({ path: `${OUT_DIR}/dev-chain-banner-local.png` })
})

test('dev page banner against mainnet', async ({ page }) => {
  await page.setViewportSize(VIEWPORT)
  await stubMainnetRpc(page)
  await seedSettings(page, FAKE_MAINNET_RPC_URL)
  await page.goto('/dev')
  await expect(page.getByText(/GNOSIS MAINNET/)).toBeVisible()
  await page.screenshot({ path: `${OUT_DIR}/dev-chain-banner-mainnet.png` })
})

test('sending xDAI and BZZ from the chain faucet', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await page.setViewportSize(VIEWPORT)
  await seedSettings(page, ANVIL_RPC_URL)

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  await page.goto('/dev')
  await page.getByRole('tab', { name: 'Chain' }).click()

  const heading = page.getByRole('heading', { name: 'Faucet' })
  await heading.scrollIntoViewIfNeeded()
  // Balances land before the send, so the shot shows both rows populated. The
  // faucet's own row is the one that proves the chain answered — the recipient
  // row renders from the typed address alone.
  await expect(page.getByText(DEV_FAUCET_ADDRESS, { exact: true })).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await send.click()
  await expect(page.getByText(/^✅ Sent /)).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })

  const top = await heading.boundingBox()
  const sendBox = await send.boundingBox()
  const PAD = 16
  await page.screenshot({
    path: `${OUT_DIR}/dev-faucet-funding.png`,
    clip: {
      x: top!.x - PAD,
      y: top!.y - PAD,
      width: VIEWPORT.width - top!.x,
      height: sendBox!.y + sendBox!.height - top!.y + PAD * 2,
    },
  })
})
