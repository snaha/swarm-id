// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared journey helpers for the e2e suites: the password create flow, the
 * demo's connect popup, buying a drive, and the network/rail seeding that
 * decides which chain and which payment arrangement a suite runs against.
 */
import { PrivateKey } from '@ethersphere/bee-js'
import { type BrowserContext, type Page, expect, test } from '@playwright/test'
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
 * "Go to app" closes the popup from its click handler — under load the window
 * can be gone before the click roundtrip returns, so tolerate that error and
 * assert the closure itself.
 */
export async function goToApp(popup: Page) {
  await popup
    .getByRole('button', { name: 'Go to app' })
    .click()
    .catch(() => undefined)
  await expect.poll(() => popup.isClosed()).toBe(true)
}

/** The identity origin, absolute because a partitioned demo is not on it. */
export const ID_ORIGIN = 'http://localhost:5500'

/**
 * Open the connect popup through the **proxy's own** button — the one rendered
 * inside `#swarm-id-button`'s iframe, beside the demo's own Connect.
 *
 * The difference is the whole partitioned path. `SwarmIdClient.connect()` opens
 * the popup from the dApp page whenever the proxy reports shared storage, and
 * `window.opener` then points at the dApp with nowhere for the handover to
 * post; the iframe's button always opens it itself, which is what sets the
 * partition challenge and makes `sendSecretToOpener` reach a proxy that cannot
 * read shared storage (#613, docs/Account-Bus.md). Both routes are covered:
 * this helper drives the iframe's button, and `bus-propagation.test.ts` drives
 * `client.connect()` under a real partition.
 */
export async function openProxyConnectPopup(page: Page) {
  await page.getByRole('button', { name: 'Connect Swarm ID' }).click()
  const button = page
    .frameLocator('#swarm-id-button iframe')
    .getByRole('button', { name: 'Connect to Swarm' })
  // Rendered only once the proxy is up; before that the container is empty.
  await expect(button).toBeVisible({ timeout: 15000 })
  const popupPromise = page.waitForEvent('popup', { timeout: 15000 })
  await button.click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  return popup
}

const PARTITION_PROBE_KEY = '__swarm-id-partition-probe'

/**
 * Prove the proxy iframe really is in its own storage partition: write a
 * sentinel into the iframe's `localStorage`, then read it back from a
 * first-party page on the identity origin. Visible ⇒ shared, absent ⇒
 * partitioned.
 *
 * Not optional, and not a one-off: Playwright's default chromium args disable
 * third-party storage partitioning, so a suite that skips this measures the
 * unpartitioned path and passes while proving nothing.
 */
export async function expectProxyPartitioned(page: Page) {
  // Attached, not visible: the client's proxy iframe is hidden by design, and
  // the button's lives inside a closed popover. Either will do — they share a
  // partition.
  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith(ID_ORIGIN)), {
      timeout: 15000,
    })
    .toBe(true)
  const proxy = page.frames().find((frame) => frame.url().startsWith(ID_ORIGIN))
  await proxy!.evaluate(
    (key) => localStorage.setItem(key, 'written-in-the-iframe'),
    PARTITION_PROBE_KEY,
  )

  const firstParty = await page.context().newPage()
  await firstParty.goto(`${ID_ORIGIN}/`)
  const seen = await firstParty.evaluate((key) => localStorage.getItem(key), PARTITION_PROBE_KEY)
  await firstParty.close()

  expect(
    seen,
    'the iframe shares the identity origin’s first-party store — this run says nothing about the partitioned path',
  ).toBeNull()
}

const SIGNALING_ORIGIN = 'ws://localhost:5520'
const BUS_JOIN_TIMEOUT_MS = 15_000

/**
 * Resolve once this page's signaling socket is in a room that already holds
 * another peer.
 *
 * Call it BEFORE the navigation that joins, and await it before publishing:
 * the room has no mailbox — `SignalingTransport.deliver` returns early while
 * `peers` is empty — and the tab's publisher debounces only 300ms, so a delta
 * sent before the peer joined is lost with nothing to re-send it.
 *
 * The `welcome` / `peer-joined` control frames are plaintext; only payloads are
 * encrypted.
 */
export function busRoomJoined(page: Page): Promise<void> {
  return page
    .waitForEvent('websocket', {
      predicate: (socket) => socket.url().startsWith(SIGNALING_ORIGIN),
      timeout: BUS_JOIN_TIMEOUT_MS,
    })
    .then((socket) =>
      socket.waitForEvent('framereceived', {
        predicate: ({ payload }) => {
          if (typeof payload !== 'string') return false
          // The socket carries whatever the server sends; a frame that is not
          // the JSON we are looking for is simply not a match, not an error.
          let frame: { type?: string; peers?: unknown[] }
          try {
            frame = JSON.parse(payload) as { type?: string; peers?: unknown[] }
          } catch {
            return false
          }
          return frame.type === 'peer-joined' || (frame.type === 'welcome' && !!frame.peers?.length)
        },
        timeout: BUS_JOIN_TIMEOUT_MS,
      }),
    )
    .then(() => undefined)
}

/**
 * The demo, browsed under a hostname that is cross-site against the identity
 * origin, so the browser partitions the proxy iframe. Ports do not affect
 * *site* — `localhost:3500` → `localhost:5500` never partitions — but a
 * loopback literal has no registrable domain, so the site falls back to
 * scheme+host and `[::1]` / `127.0.0.1` are cross-site against `localhost`.
 * Loopback is still a secure context, so `crypto.subtle` is there.
 *
 * Which literal answers depends on what `localhost` resolved to when vite
 * bound the dev server, so probe rather than assume.
 */
export async function partitionedDemoOrigin(): Promise<string | undefined> {
  for (const origin of ['http://127.0.0.1:3500', 'http://[::1]:3500']) {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      return origin
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Point the app at the local chain. Any suite that buys a drive needs this now
 * that purchases are real — `seedNoChain` is for suites deliberately testing
 * what happens without one.
 *
 * Must run before the first page load; the settings are read at app init.
 *
 * Takes a whole context where the popup needs the settings too: on the
 * partitioned path the proxy cannot read them from storage, so it uses the copy
 * the connect popup hands over (`sendSecretToOpener`), and a popup is a page
 * `page.addInitScript` never reaches.
 */
export function seedLocalChain(page: Page | BrowserContext, rpcUrl: string = CHAIN_RPC_URL) {
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
 * Buy a drive through the normal flow, from the home page (Storage tab), on the
 * built-in engine.
 *
 * Proceed now opens the method chooser — every route parts there, before
 * anything touches the chain — so this picks the engine explicitly. A suite
 * that wants fund.bzz.limo passes `method: 'widget'`, which is what reaches the
 * /dev mock. Either way a chain is needed — gate with {@link chainReachable}.
 *
 * A settled purchase ends on a modal success screen whose Done click this
 * waits for — the page behind it is not interactable until then. Suites whose
 * purchase never succeeds (a dead RPC, a mocked failure) pass
 * `settle: false` and assert the error/payment state themselves with
 * `DRIVE_SETTLE_TIMEOUT_MS`.
 */
export async function addDrive(
  page: Page,
  { settle = true, method = 'built-in' }: { settle?: boolean; method?: 'built-in' | 'widget' } = {},
) {
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
  // The chooser, which opens whatever the owner address holds.
  await dialog.getByRole('combobox').first().selectOption(method)
  await dialog
    .getByRole('button', { name: method === 'widget' ? 'Continue to fund.bzz.limo' : 'Continue' })
    .click()
  if (settle) {
    await dialog.getByRole('button', { name: 'Done' }).click({ timeout: DRIVE_SETTLE_TIMEOUT_MS })
  }
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
 *
 * What this buys the e2e rig, and what it does not: pre-funding the owner
 * means `quoteFunding` always comes back needing zero, so a suite that calls
 * this gets the method chooser (which opens either way) but never the pay
 * screens behind it, and never exercises a payment rail
 * (`gnosis-direct.ts` and friends) — those are covered by
 * `payment-rail.test.ts` and the multichain unit/fork tests, not here.
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
 *
 * Re-implemented rather than imported — keep this in step with
 * `derivePostageSignerKey` in `lib/src/utils/key-derivation.ts`, the source of
 * truth this must match.
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

/** The Bee node `seedLocalChain` points the app at. */
export const BEE_API_URL = 'http://localhost:1633'

const INGEST_TIMEOUT_MS = 180_000
const INGEST_POLL_MS = 5_000

/**
 * Wait until the Bee node knows the account's default batch.
 *
 * A purchase settles on chain; the node only learns of it by watching, and
 * until it has, every stamped write is rejected with `invalid batch id` — the
 * partition-lock SOC included, so the failure surfaces as a lease that cannot
 * be acquired rather than as anything about the batch.
 */
export async function waitForBatchIngestion(page: Page, beeUrl: string = BEE_API_URL) {
  const wanted = await page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { defaultPostageStampBatchID?: string }[]
    }
    return doc.data?.[0]?.defaultPostageStampBatchID
  })
  expect(wanted, 'the account has no default batch — did the purchase settle?').toBeTruthy()

  await expect
    .poll(
      async () => {
        const response = await fetch(`${beeUrl}/batches`)
        const { batches = [] } = (await response.json()) as { batches?: { batchID: string }[] }
        return batches.some((batch) => batch.batchID.toLowerCase() === wanted!.toLowerCase())
      },
      { timeout: INGEST_TIMEOUT_MS, intervals: [INGEST_POLL_MS] },
    )
    .toBe(true)
}

/** Whether a local Bee cluster is answering, so an upload suite can skip
 *  rather than fail. CI runs a chain but no cluster (`pnpm dev:local` does). */
export async function beeReachable(beeUrl: string = BEE_API_URL): Promise<boolean> {
  try {
    const response = await fetch(`${beeUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
