// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared journey helpers for the e2e suites: the password create flow, the
 * demo's connect popup, buying a drive, and the network/rail seeding that
 * decides which chain and which payment arrangement a suite runs against.
 */
import { PrivateKey } from '@ethersphere/bee-js'
import { type Page, expect } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { fundLocalAccount } from '@swarm-id/multichain/dev'

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
 * Start a drive purchase through the normal flow, from the home page (Storage
 * tab), and leave it settling.
 *
 * Every suite that calls this needs a chain: buying is a real on-chain
 * purchase, with no simulated settlement to fall back on. Gate with
 * {@link chainReachable}. It settles asynchronously — a successful one lands on
 * the screen {@link confirmPurchased} dismisses, a failed one on the error
 * phase, which callers assert with `DRIVE_SETTLE_TIMEOUT_MS`.
 */
export async function addDrive(page: Page) {
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Add drive' }).click()
  await page.getByRole('dialog').getByRole('combobox').nth(1).selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Proceed' }).click()
}

/**
 * Wait out a purchase started by {@link addDrive} and acknowledge it.
 *
 * Money moved, so the flow stops on a success screen and says what it bought
 * instead of vanishing behind a toast. That screen is modal: until it is
 * dismissed its backdrop swallows every click on the page behind it, so this is
 * not decoration — it is how a suite gets back to the drive list.
 *
 * @param resumed asserts the "finished an earlier unfinished purchase" ending
 *   rather than the "bought the drive you configured" one.
 */
export async function confirmPurchased(page: Page, resumed = false) {
  const dialog = page.getByRole('dialog')
  const title = resumed ? 'Earlier purchase completed' : 'Purchase completed!'
  await expect(dialog.getByText(title)).toBeVisible({ timeout: DRIVE_SETTLE_TIMEOUT_MS })
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
}

export const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL ?? 'http://localhost:9545'

/**
 * One depth-17 drive at the default one-year lifespan costs ~2 BZZ, measured
 * against the baked chain; three is headroom for price drift. The xDAI is ten
 * times the operation's fixed gas budget, which is what `fundingShortfall`
 * compares against — under it, a need is raised however much BZZ is there.
 */
const DRIVE_FUNDING = {
  xdai: 5n * 10n ** 16n, // 0.05 xDAI
  bzzPlur: 3n * 10n ** 16n, // 3 BZZ (16 decimals)
}

/**
 * Put money in the account's postage signer, from the chain faucet, so the
 * purchase ahead finds it already there and opens no payment screen.
 *
 * Must run after the account exists (its derivation key is read from storage)
 * and before the operation that spends. Suites that assert a FAILED purchase
 * deliberately skip it.
 */
export async function fundPostageSigner(page: Page) {
  const to = await postageSignerAddress(page)
  await fundLocalAccount(
    { to, ...DRIVE_FUNDING },
    gnosisMainnetSettings({ rpcUrls: [CHAIN_RPC_URL] }),
  )
}

/**
 * Where that money has to land: the account's postage signer, derived the way
 * the app derives it — HMAC-SHA256 over the label `postage-signer`, keyed by
 * the account's derivation key (`lib/src/utils/key-derivation.ts`).
 *
 * Derived inside the page rather than here because the lib ships one bundle and
 * it is the browser one: importing `derivePostageSignerKey` into the Node test
 * process pulls a browser build of bee-js and dies on `window is not defined`.
 * The page has both WebCrypto and the account, so it is also where the question
 * belongs. If the derivation ever changes, every funded purchase fails loudly —
 * the money lands at an address the operation is not looking at, so it raises a
 * funding need and the payment screen opens over the test.
 */
async function postageSignerAddress(page: Page): Promise<`0x${string}`> {
  const signerKey = await page.evaluate(async () => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { derivationKey?: string }[]
    }
    const derivationKey = doc.data?.[0]?.derivationKey
    if (!derivationKey) {
      return undefined
    }
    const keyBytes = Uint8Array.from(
      (derivationKey.match(/../g) ?? []).map((byte) => parseInt(byte, 16)),
    )
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode('postage-signer'),
    )
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  })
  if (!signerKey) {
    throw new Error('No account in storage — create one before funding its signer.')
  }
  return new PrivateKey(signerKey).publicKey().address().toChecksum() as `0x${string}`
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
