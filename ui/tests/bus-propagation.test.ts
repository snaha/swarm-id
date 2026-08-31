// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The account bus, end to end (#569, docs/Account-Bus.md).
 *
 * Everything here needs the proxy iframe's storage genuinely partitioned, which
 * is what makes the bus the ONLY channel between it and the identity tab:
 * `storage` events and `BroadcastChannel` are both scoped to a partition, so a
 * message that arrives arrived over the signaling server. That is also why a
 * second browser context is unnecessary — one context holds both halves, and
 * the partition is the isolation that matters.
 *
 * The rig is a second hostname, nothing more. Browsing the demo under a
 * loopback literal while the proxy origin stays the absolute
 * `http://localhost:5500` makes the two cross-site (a loopback literal has no
 * registrable domain, so the site is scheme+host), and loopback is still a
 * secure context so `crypto.subtle` is there. No host aliases, no HTTPS.
 *
 * Runs in the `chromium-partitioned` project, which is the only one that leaves
 * `ThirdPartyStoragePartitioning` on — see `playwright.config.ts`.
 */
import { type Page, expect, test } from '@playwright/test'

import {
  CHAIN_TEST_TIMEOUT_MS,
  DRIVE_SETTLE_TIMEOUT_MS,
  ID_ORIGIN,
  PASSWORD,
  addDrive,
  beeReachable,
  busRoomJoined,
  chainReachable,
  completeCreateFlow,
  expectProxyPartitioned,
  fundPostageSigner,
  goToApp,
  openConnectPopup,
  openProxyConnectPopup,
  partitionedDemoOrigin,
  seedLocalChain,
  waitForBatchIngestion,
} from './helpers'

const demoOrigin = await partitionedDemoOrigin()
const NO_LOOPBACK_LITERAL =
  'the demo dev server answered on neither loopback literal — nothing to browse cross-site'
// Locally a missing demo server is a reason to skip; in CI it is the rig
// breaking. A `--host` change that stops the literals answering would otherwise
// leave `chromium-partitioned` green-skipping forever, which is the one outcome
// this suite exists to prevent.
if (!demoOrigin && process.env.CI) {
  throw new Error(NO_LOOPBACK_LITERAL)
}
test.skip(!demoOrigin, NO_LOOPBACK_LITERAL)

/** An upload needs a real node; CI runs a chain but no cluster. */
const beeUp = await beeReachable()
const chainUp = await chainReachable()

/**
 * The purchase, plus the node's own wait to see it on chain (up to 3 min on a
 * cold cluster), plus the round trip.
 */
const UPLOAD_TEST_TIMEOUT_MS = 360_000

/** The name the identity tab renames the account to, mid-test. */
const RENAMED = 'Renamed On Another Device'

/**
 * An account with a drive, created standalone on the identity origin.
 *
 * The drive is not decoration. `accountStateSnapshot` returns `undefined`
 * without a `defaultPostageStampBatchID`, so a driveless account never
 * publishes an `account-delta` at all — the bus would be silent for reasons
 * that have nothing to do with the transport.
 */
async function createAccountWithDrive(page: Page) {
  await page.goto(`${ID_ORIGIN}/`)
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  await fundPostageSigner(page)
  await addDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
}

/**
 * Connect an existing account to the demo through the proxy's own iframe
 * button, and leave the partitioned session live.
 *
 * Do not navigate the demo afterwards: a partitioned session's credentials live
 * only in memory (the popup re-seeds them on every load), so a reload ends it.
 */
async function connectPartitioned(page: Page, path: string) {
  await page.goto(`${demoOrigin}${path}`)
  const popup = await openProxyConnectPopup(page)
  await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
  await popup.getByRole('textbox', { name: 'Account password' }).fill(PASSWORD)
  await popup.getByRole('button', { name: 'Confirm' }).click()
  await goToApp(popup)
}

/** The same, but creating the account inside the popup — so it has no drive. */
async function connectPartitionedNewAccount(page: Page, path: string) {
  await page.goto(`${demoOrigin}${path}`)
  const popup = await openProxyConnectPopup(page)
  await completeCreateFlow(popup)
  await expect(popup).toHaveURL(/\/connect\/done$/)
  await goToApp(popup)
}

/** The identity tab, in the same context, already in the account's bus room. */
async function openIdentityTab(page: Page, tab: 'apps' | 'account') {
  const idPage = await page.context().newPage()
  // Armed before the navigation that joins: the room has no mailbox, so a delta
  // published before this tab is in it is lost with nothing to re-send it.
  const joined = busRoomJoined(idPage)
  // Handled here so a join timeout does not surface as an unhandled rejection
  // while the `goto` is still running — the `await` below still throws it, so a
  // genuine failure of either is reported, whichever happens first.
  joined.catch(() => undefined)
  await idPage.goto(`${ID_ORIGIN}/?tab=${tab}`)
  await joined
  return idPage
}

test('the proxy iframe is in its own storage partition', async ({ page }) => {
  await page.goto(`${demoOrigin}/`)
  await expectProxyPartitioned(page)
})

// The situation the first real-Safari run (#584) actually hit: a partitioned
// session whose account has no drive. The handover landed — that is what
// `storagePartitioned` means, and the proxy sets it in one place — while the
// writer path was never exercised. The harness reported the second as a failure
// of the first, which is a claim about ITP, so it is worth a test that needs
// neither a chain nor a Bee node and therefore runs on every PR.
test('a partitioned session with no drive reports the handover, not a failure', async ({
  page,
}) => {
  await seedLocalChain(page.context())
  await connectPartitionedNewAccount(page, '/safari-check')

  await expect(
    page.getByText(
      'Partitioned, and the session is authenticated — only the popup’s postMessage through window.opener can do that here, so it survived ITP.',
    ),
  ).toBeVisible({ timeout: 15000 })
  await expectProxyPartitioned(page)
  await expect(page.getByText('This account has no drive', { exact: false })).toBeVisible()
  // Grey, not red: nothing here is evidence against the feature.
  await expect(page.getByText('❌')).toHaveCount(0)
})

// #613: the transport used to be picked by user agent, so a partitioned
// Chromium was put on the storage-event path — which cannot reach it — while
// only WebKit got the handover. Every test above reaches the popup through the
// PROXY's own button (`openProxyConnectPopup`), which always delegated; this one
// goes through the demo's own Connect button, i.e. `client.connect()`, the API a
// dApp with its own button uses. It fails on the UA gate by construction.
test('client.connect() authenticates a partitioned session', async ({ page }) => {
  await page.goto(`${demoOrigin}/account`)
  await expectProxyPartitioned(page)

  const popup = await openConnectPopup(page)
  await completeCreateFlow(popup)
  await expect(popup).toHaveURL(/\/connect\/done$/)
  await goToApp(popup)

  // The demo renders `ConnectionInfo.identity.name`, so the account card is
  // proof the session authenticated — and `expectProxyPartitioned` above is
  // what makes that proof about the partitioned path rather than a shared one.
  await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({ timeout: 15000 })
})

test('the bus carries an app removal to a partitioned session', async ({ page }) => {
  test.skip(!chainUp, 'requires a local chain: the account needs a drive to publish a delta at all')
  test.setTimeout(CHAIN_TEST_TIMEOUT_MS)

  await seedLocalChain(page.context())
  await createAccountWithDrive(page)
  await connectPartitioned(page, '/account')

  // The demo renders `ConnectionInfo.identity.name`, so the account card is
  // proof the popup's `window.opener` handover landed.
  await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({ timeout: 15000 })
  await expectProxyPartitioned(page)
  const shownName = page.getByText('Name', { exact: true }).locator('xpath=following-sibling::div')
  const connectedName = await shownName.innerText()

  const idPage = await openIdentityTab(page, 'account')

  // A rename DOES reach the session: since #610 the fold merges the metadata
  // scalars on their own per-field clocks, not just the collections, so
  // `identity.name` follows a rename made on another device with no reconnect
  // and no reload. (It did not before — this suite asserted the old behaviour
  // and #610 flipped the line, which is what it was there for.)
  await idPage.getByRole('button', { name: /^Identity/ }).click()
  await idPage.getByRole('textbox').fill(RENAMED)
  await idPage.getByRole('textbox').press('Enter')
  await expect(idPage.getByRole('textbox')).toHaveValue(RENAMED)
  // Or the assertion below would pass on the handover's own name.
  expect(connectedName).not.toBe(RENAMED)
  await expect(shownName).toHaveText(RENAMED, { timeout: 15000 })

  // Removal, not Disconnect: only a TOMBSTONED entry ends a partitioned
  // session. `restoreLocalSessionFields` keeps this context's own `appSecret`
  // and `connectedUntil` over an incoming entry — a peer's copy of a session
  // deadline is not its to set — and tombstones are the one exception.
  await idPage.getByRole('tab', { name: 'Apps' }).click()
  await idPage.getByRole('button', { name: 'App actions' }).click()
  await idPage.getByRole('menuitem', { name: 'Remove' }).click()

  await expect(page.getByRole('heading', { name: 'Not connected' })).toBeVisible({
    timeout: 15000,
  })
})

test('a partitioned session uploads with its own stamp and reads it back', async ({ page }) => {
  test.skip(!chainUp || !beeUp, 'requires a local chain and bee cluster (pnpm dev:local)')
  test.setTimeout(UPLOAD_TEST_TIMEOUT_MS)

  // The drive has to exist before the connect: on the partitioned path the
  // stamps a session can spend are the ones the popup hands over, and there is
  // no shared storage to pick up a later one from.
  await seedLocalChain(page.context())
  await createAccountWithDrive(page)

  await waitForBatchIngestion(page)

  // #584's hand-run harness, driven here: it reaches its own verdicts on
  // screen, which is exactly the assertion surface this needs.
  await connectPartitioned(page, '/safari-check')

  await expect(
    page.getByText('Holding its own stamp — the hydrated account view built a working write path.'),
  ).toBeVisible({ timeout: 15000 })

  await page.getByRole('button', { name: 'Upload & read back' }).click()
  await expect(page.getByText('Uploaded and read back byte-identical.')).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
})
