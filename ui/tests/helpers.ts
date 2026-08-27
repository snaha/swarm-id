// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared journey helpers for the e2e suites: the password create flow, the
 * demo's connect popup, buying a drive, and the network/rail seeding that
 * decides which chain and which payment arrangement a suite runs against.
 */
import { PrivateKey } from '@ethersphere/bee-js'
import { type Page, expect, test } from '@playwright/test'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { fundLocalAccount } from '@swarm-id/multichain/dev'

import { workerFaucetKey } from './worker-faucet'

export const PASSWORD = 'testpassword123'

/** Buying a drive is a real on-chain purchase: funding, then an approve +
 * createBatch bundle, then reading the batch back — several 5s blocks. The
 * slowest one measured takes under 30s, so this is margin, not a budget. */
export const DRIVE_SETTLE_TIMEOUT_MS = 75_000

/**
 * What a whole journey that buys a drive is allowed. Applied per test, and
 * only to the tests that reach the chain — a suite-wide budget hands the same
 * minutes to the two-second tests beside them, and it is the FAILING ones that
 * spend it.
 *
 * Three times the slowest one measured (51s, with the workers running).
 */
export const CHAIN_TEST_TIMEOUT_MS = 150_000

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
 * Stops at Proceed, which is where the two payment methods part. A funded
 * signer needs no payment at all and settles from here; an unfunded one opens
 * the payment screens, where choosing fund.bzz.limo is what reaches the /dev
 * mock. Either way a chain is needed — gate with {@link chainReachable}.
 *
 * It settles asynchronously — callers assert the outcome (a "Drive xxxx" card,
 * or the error phase) with `DRIVE_SETTLE_TIMEOUT_MS`.
 */
export async function addDrive(page: Page) {
  await page.getByRole('tab', { name: 'Storage' }).click()
  await page.getByRole('button', { name: 'Add drive' }).click()
  const dialog = page.getByRole('dialog')
  // The smallest size on offer — index 1, past the "Please select" placeholder.
  await dialog.getByRole('combobox').nth(1).selectOption({ index: 1 })
  // ...and an explicit lifespan, rather than the dialog's default of a YEAR. A
  // drive costs `amountPerChunk << depth`, so both halves matter, and
  // `DRIVE_FUNDING` is a fixed 3 BZZ: a year at this size is ~7.9 BZZ, so the
  // prefunded suites would open the payment screens they exist to avoid and
  // then fail waiting for a drive that never settles.
  //
  // 30 days sits between two bounds: ~0.65 BZZ leaves
  // room inside the 3 BZZ float, and it clears the 7-day
  // `EXPIRES_SOON_THRESHOLD_SECONDS` by a wide margin. A drive bought AT that
  // threshold reads "expires soon" the moment it settles, which quietly adds a
  // second drive to the home page's attention count.
  await dialog.getByRole('spinbutton').fill('30')
  await dialog.getByRole('combobox').nth(2).selectOption('days')
  await page.getByRole('button', { name: 'Proceed' }).click()
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
    // From this slot's own faucet, never the chain's: workers run at the same
    // time, and two of them signing from one address race its nonce.
    // `parallelIndex`, not `workerIndex` — see `worker-faucet.ts`.
    { to, ...DRIVE_FUNDING, from: workerFaucetKey(test.info().parallelIndex) },
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
