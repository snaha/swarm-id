// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Screenshot capture for the drive extend / resize / payment flows, for PR
 * review against the Figma designs. NOT part of the test suite — the filename
 * is outside Playwright's default `*.test.ts` glob. Run explicitly:
 *
 *   pnpm dev:local   # repo root, for the anvil chain
 *   pnpm exec playwright test --config=playwright.capture.config.ts
 *
 * PNGs land in `screenshots/`.
 *
 * The on-chain screens are real: a batch owned by the account's derived signer
 * on the bee-compose chain, extended and resized by actual transactions. The
 * payment screens cannot be: the local chain has no DEX and no Relay, and
 * there is no wallet in the browser — so the swap quote, the Relay quote and
 * an injected wallet are stubbed at the network/window boundary. The
 * components and their data flow are the production ones.
 */
import { type Page, expect, test } from '@playwright/test'

import { completeCreateFlow } from './helpers'

const ANVIL_RPC_URL = 'http://localhost:9545'
const BEE_NODE_URL = 'http://localhost:1633/'
const OUT_DIR = 'screenshots'
const ONCHAIN_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 2000
/** Viewport matching the designs' 1366×768 frames. */
const VIEWPORT = { width: 1366, height: 768 }

const SUSHI_QUOTER = '0xb1e835dc2785b52265711e17fccb0fd018226a6e'
/** Stub rate: 1 BZZ (1e16 PLUR) ≈ 0.4 xDAI, near the real market price. */
const STUB_WEI_PER_PLUR = 40n

/**
 * Payment screens need the mainnet settings preset (the local one has no DEX
 * — by design), so they run against this fake RPC host, which
 * `mainnetFacadeOverAnvil` translates onto the local chain.
 */
const FACADE_RPC_URL = 'http://gnosis-facade.test/rpc'
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

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

/**
 * Present the local chain as if it were Gnosis mainnet: report mainnet's chain
 * id AND genesis hash (the app tells the two apart by genesis, since the chain
 * id matches on purpose), and answer the SushiSwap quoter proportionally to the
 * requested BZZ so the price-impact guard sees a flat market. Everything else
 * is forwarded to the chain untouched — it already carries PostageStamp and BZZ
 * at their Gnosis addresses.
 *
 * This exists ONLY so the payment screens — which off mainnet are replaced by a
 * simulated settlement — can be captured. No application code is aware of it.
 */
async function mainnetFacadeOverAnvil(page: Page) {
  await page.route(`${FACADE_RPC_URL}**`, async (route) => {
    const body = route.request().postDataJSON() as {
      id?: number
      method?: string
      params?: unknown[]
    }
    const respond = (result: unknown) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result }),
      })

    if (body?.method === 'eth_chainId') {
      await respond(GNOSIS_CHAIN_ID_HEX)
      return
    }

    // Genesis is how the app tells mainnet from a dev chain, and the payment
    // screens only exist on the mainnet side of that check.
    if (body?.method === 'eth_getBlockByNumber' && body?.params?.[0] === '0x0') {
      await respond({ hash: GNOSIS_GENESIS_HASH })
      return
    }

    const call = body?.params?.[0] as { to?: string; data?: string } | undefined
    const to = call?.to?.toLowerCase()
    if (body?.method === 'eth_call' && to === SUSHI_QUOTER) {
      // (address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 limit)
      const AMOUNT_WORD_OFFSET = 10 + 2 * 64
      const plur = BigInt(`0x${call!.data!.slice(AMOUNT_WORD_OFFSET, AMOUNT_WORD_OFFSET + 64)}`)
      await respond(`0x${word(plur * STUB_WEI_PER_PLUR)}${word(0n)}${word(0n)}${word(0n)}`)
      return
    }

    // No address translation: the local chain carries PostageStamp and BZZ at
    // their Gnosis addresses, so a call to either already lands where it should.
    const response = await fetch(ANVIL_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await route.fulfill({ contentType: 'application/json', body: await response.text() })
  })
}

/** Canned Relay quote — the SDK's live API is not reachable from a test run. */
async function stubRelayQuote(page: Page) {
  await page.route('https://api.relay.link/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        steps: [],
        details: {
          currencyIn: {
            currency: { chainId: 8453, symbol: 'USDC', decimals: 6 },
            amount: '170000',
            amountFormatted: '0.17',
            amountUsd: '0.17',
          },
        },
      }),
    })
  })
}

/**
 * A minimal injected wallet so the payment screen can reach its connected
 * state. Reports Ethereum mainnet, the chain web3-onboard is configured with
 * and the payment screen's default selection.
 */
async function stubInjectedWallet(page: Page) {
  await page.addInitScript(() => {
    const address = '0x7122F2fE4Bf1a4dDeF1D0e1a5c9b52E2eb9E2Ca4'
    const provider = {
      isMetaMask: true,
      selectedAddress: address,
      chainId: '0x1',
      async request({ method }: { method: string }) {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address]
          case 'eth_chainId':
            return '0x1'
          case 'net_version':
            return '1'
          case 'eth_getBalance':
            return '0x0'
          case 'wallet_getPermissions':
          case 'wallet_requestPermissions':
            return [{ parentCapability: 'eth_accounts' }]
          default:
            return null
        }
      },
      on: () => undefined,
      removeListener: () => undefined,
    }
    Object.defineProperty(window, 'ethereum', { value: provider, writable: true })
  })
}

/** Screenshot after CSS transitions settle, so toggles and buttons are
 * captured in their final state rather than mid-animation. */
const TRANSITION_SETTLE_MS = 400
async function shoot(page: Page, name: string) {
  await page.waitForTimeout(TRANSITION_SETTLE_MS)
  await page.screenshot({ path: `${OUT_DIR}/${name}.png` })
}

function storedDriveDepth(page: Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { depth: number }[] }[]
    }
    return doc.data?.[0]?.postageStamps?.[0]?.depth
  })
}

/** Account + a drive whose batch the account's signer owns on the local chain. */
async function seedDrive(page: Page) {
  await page.addInitScript(
    ([rpcUrl, beeUrl]) => {
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: beeUrl, gnosisRpcUrl: rpcUrl }),
      )
    },
    [ANVIL_RPC_URL, BEE_NODE_URL] as const,
  )

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  await page.goto('/dev')
  await page.getByRole('tab', { name: 'Chain' }).click()
  await page.getByRole('button', { name: 'Create owned batch (depth 20)' }).click()
  const created = page.getByText(/^Created owned batch: 0x[0-9a-f]{64}$/)
  await expect(created).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  const batchId = (await created.textContent())?.replace('Created owned batch: ', '').trim() ?? ''
  const signerKey =
    (await page
      .getByText(/^[0-9a-f]{64}$/)
      .first()
      .textContent()) ?? ''

  await page.getByRole('textbox', { name: 'Batch ID' }).fill(batchId)
  await page.getByRole('textbox', { name: 'Signer Key' }).fill(signerKey)
  await page.getByRole('button', { name: 'Import batch' }).click()
  await expect.poll(() => storedDriveDepth(page), { timeout: ONCHAIN_TIMEOUT_MS }).toBe(20)

  await page.goto('/')
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Expand drive' }).click()
}

test.describe.configure({ mode: 'serial' })
test.skip(!chainUp, 'requires the bee-compose chain (pnpm dev:local)')
test.use({ viewport: VIEWPORT })

test('capture: extend, resize and on-chain progress', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 3)
  await seedDrive(page)

  // --- Extend -------------------------------------------------------------
  await page.getByRole('button', { name: 'Extend lifespan' }).click()
  const extend = page.getByRole('dialog')
  await shoot(page, '01-extend-empty')

  await extend.getByRole('combobox').selectOption('days')
  await extend.getByRole('button', { name: 'Increase' }).click()
  await extend.getByRole('button', { name: 'Increase' }).click()
  await expect(extend.getByText(/Estimated cost/)).toBeVisible()
  await shoot(page, '02-extend-filled')

  // Progress while the on-chain sequence runs.
  await extend.getByRole('button', { name: 'Proceed' }).click()
  await expect(page.getByText(/Approving|Extending|Checking|Waiting/)).toBeVisible()
  await shoot(page, '03-extend-progress')
  await expect(page.getByText('Lifespan extended')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  await shoot(page, '04-extend-done')

  // --- Resize -------------------------------------------------------------
  await page.getByRole('button', { name: 'Increase size' }).click()
  const resize = page.getByRole('dialog')
  await shoot(page, '05-resize-empty')

  await resize.getByRole('combobox').selectOption('21')
  await expect(resize.getByText(/Estimated cost/)).toBeVisible()
  await shoot(page, '06-resize-keep-lifespan')

  await resize.getByRole('switch', { name: 'Keep current lifespan' }).click()
  await expect(resize.getByText(/Lifespan reduced to/)).toBeVisible()
  await shoot(page, '07-resize-shorter-lifespan')

  await resize.getByRole('switch', { name: 'Keep current lifespan' }).click()
  await resize.getByRole('button', { name: 'Proceed' }).click()
  await expect(page.getByText(/Checking|Waiting|Approving|Paying|Increasing/)).toBeVisible()
  await shoot(page, '08-resize-progress')
  await expect(page.getByText('Drive size increased')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  await shoot(page, '09-resize-done')
})

test('capture: payment screens', async ({ page }) => {
  test.setTimeout(ONCHAIN_TIMEOUT_MS * 2)
  await stubInjectedWallet(page)
  await mainnetFacadeOverAnvil(page)
  await stubRelayQuote(page)
  // Creating the batch needs REAL writes, so seed against anvil directly...
  await seedDrive(page)
  // ...then point the app at the mainnet-shaped RPC, which selects the
  // settings preset carrying the DEX addresses. Only reads and quotes run
  // from here on, so nothing is signed against the facade.
  // Added after the seeding script so it wins on the reload below (init
  // scripts run in registration order).
  await page.addInitScript((rpcUrl) => {
    const settings = JSON.parse(localStorage.getItem('swarm-id-network-settings') ?? '{}')
    localStorage.setItem(
      'swarm-id-network-settings',
      JSON.stringify({ ...settings, gnosisRpcUrl: rpcUrl }),
    )
  }, FACADE_RPC_URL)
  await page.reload()
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Expand drive' }).click()

  await page.getByRole('button', { name: 'Extend lifespan' }).click()
  const extend = page.getByRole('dialog')
  // Years, not days: the payment screens only appear when the operation raises
  // a funding need, and the signer still holds the change from the purchase
  // that seeded this drive — a day costs less than that, so a small extend
  // settles silently and never reaches a payment screen.
  await extend.getByRole('combobox').selectOption('years')
  await extend.getByRole('button', { name: 'Increase' }).click()
  await extend.getByRole('button', { name: 'Proceed' }).click()

  // Method chooser.
  await expect(page.getByText('Connect wallet to proceed')).toBeVisible({
    timeout: ONCHAIN_TIMEOUT_MS,
  })
  await shoot(page, '10-payment-method')

  // Connected: chain / token / quoted cost with the xBZZ + xDAI breakdown.
  // web3-onboard asks which wallet to use (its own modal) before connecting.
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'MetaMask' }).click()
  await expect(page.getByText('Connected wallet')).toBeVisible({ timeout: ONCHAIN_TIMEOUT_MS })
  // Let onboard's own connect modal finish dismissing before capturing.
  await expect(page.getByText('Connection Successful')).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText(/Estimated cost/)).toBeVisible()
  await shoot(page, '11-payment-pay')
})
