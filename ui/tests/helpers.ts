// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared journey helpers for the e2e suites: the password create flow, the
 * demo's connect popup, buying a drive, and the network/rail seeding that
 * decides which chain and which payment arrangement a suite runs against.
 */
import { type Page, expect } from '@playwright/test'

export const PASSWORD = 'testpassword123'

/** Buying a drive is a real on-chain purchase: funding, then an approve +
 * createBatch bundle, then reading the batch back — several 5s blocks. */
export const DRIVE_SETTLE_TIMEOUT_MS = 120_000

/**
 * Drives the account-creation wizard from /account/new to completion using the
 * Password access method (needs no WebAuthn/wallet test infra). Where the flow
 * lands afterwards depends on the entry point: the done page when standalone,
 * /connect/done inside a connect popup.
 */
export async function completeCreateFlow(page: Page) {
  await page.getByRole('link', { name: 'Create a new account' }).click()
  await expect(page).toHaveURL(/\/account\/new$/)
  // Name is prefilled with a generated one.
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/phrase$/)
  await page.getByRole('button', { name: 'Reveal' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page).toHaveURL(/\/account\/new\/access$/)
  await page.getByRole('tab', { name: 'Password' }).click()
  await page.locator('#new-password').fill(PASSWORD)
  await page.locator('#verify-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Confirm' }).click()
}

/** Opens the demo's connect popup and returns the popup page. */
export async function openConnectPopup(page: Page) {
  await page.getByRole('button', { name: 'Connect Swarm ID' }).click()
  // The lib renders the iframe button once the client is initialized — before
  // that, the popover's Connect click is a silent no-op (clientStore.connect
  // bails while `client` is undefined).
  await expect(page.locator('#swarm-id-button iframe')).toBeVisible({ timeout: 10000 })
  let popup: Page | undefined
  await expect(async () => {
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => undefined)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    popup = await popupPromise
    if (!popup) {
      // Clicking Connect closes the popover — reopen it for the retry.
      await page.getByRole('button', { name: 'Connect Swarm ID' }).click()
      throw new Error('connect popup did not open')
    }
  }).toPass({ timeout: 30000 })
  await popup!.waitForLoadState()
  return popup!
}

/**
 * Point the app at the local chain. Any suite that buys a drive needs this now
 * that purchases are real — `seedNoChain` is for suites deliberately testing
 * what happens without one.
 *
 * Must run before the first page load; the settings are read at app init.
 */
export function seedLocalChain(page: Page, rpcUrl: string = CHAIN_RPC_URL) {
  return page.addInitScript(
    (url) =>
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: 'http://localhost:1633/', gnosisRpcUrl: url }),
      ),
    rpcUrl,
  )
}

export function seedNoChain(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      'swarm-id-network-settings',
      JSON.stringify({
        beeNodeUrl: 'http://localhost:1633/',
        // Connection refused immediately, rather than a slow DNS failure.
        gnosisRpcUrl: 'http://127.0.0.1:1',
      }),
    )
  })
}

/**
 * Buy a drive through the normal flow, from the home page (Storage tab).
 *
 * Every suite that calls this needs a chain: buying is a real on-chain
 * purchase, with no simulated settlement to fall back on. Gate with
 * {@link chainReachable}. It settles asynchronously — callers assert the
 * outcome (a "Drive xxxx" card, or the error phase) with
 * `DRIVE_SETTLE_TIMEOUT_MS`.
 */
export async function addDrive(page: Page) {
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Add drive' }).click()
  await page.getByRole('dialog').getByRole('combobox').nth(1).selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Proceed' }).click()
}

export const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://localhost:9545'

/**
 * Pin the payment rail OFF for a suite: with no source chain reachable there is
 * no rail, so funding falls back to the faucet and no wallet is needed. Without
 * this a developer running `pnpm dev:local` would get the payment screens and
 * the same test would behave differently than in CI.
 */
export async function pinNoPaymentRail(page: Page) {
  await page.addInitScript(() =>
    // A port nothing listens on — the probe fails fast and the rail resolves
    // to undefined.
    localStorage.setItem('swarm-id-dev-source-rpc', 'http://127.0.0.1:1'),
  )
}
const PROBE_TIMEOUT_MS = 2000

/** Whether a local chain is answering, so a suite can skip rather than fail. */
export async function chainReachable(rpcUrl: string = CHAIN_RPC_URL): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
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
