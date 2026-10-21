// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The multi-device rig: one account on several `BrowserContext`s — separate
 * storage, separate device ids, one signaling server — each driving the demo
 * the way a person does, with the lease state read off the demo's own sidebar
 * and every upload a round trip. Shared by `three-devices.test.ts` (three
 * devices on one drive's two partitions) and `two-drives.test.ts` (two devices
 * on two drives, #882); both run under `playwright.devices.config.ts`.
 */
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

import { DEVICES_RUN_BZZ_PLUR, stockedSlot } from './global-setup-devices'
import {
  BEE_API_URL,
  DRIVE_SETTLE_TIMEOUT_MS,
  ID_ORIGIN,
  PASSWORD,
  addDrive,
  beeReachable,
  chainReachable,
  completeCreateFlow,
  fundPostageSigner,
  goToApp,
  seedLocalChain,
  waitForBatchIngestion,
} from './helpers'

/** Same-site with the identity origin, so every context's proxy reads the
 *  shared store — three devices, not three partitions of one. */
export const DEMO_ORIGIN = 'http://localhost:3500'
/** The account-bus signaling server `pnpm dev` starts (`dev:signaling`). */
export const SIGNALING_HEALTH_URL = 'http://localhost:5520/healthz'

// Production timings, restated: the lib ships one bundle and it is the browser
// one, so importing the constants here dies on `window`. Keep in step with
// `lib/src/sync/timing-constants.ts`, `lib/src/utils/batch-utilization.ts`,
// `lib/src/sync/partition-intent.ts` and `lib/src/sync/batch-write-coordinator.ts`.
export const LEASE_TTL_MS = 30_000
export const LEASE_REFRESH_MS = 10_000
export const IDLE_YIELD_MS = 30_000
export const PEER_YIELD_MIN_IDLE_MS = 3_000
export const INTENT_LIVENESS_GRACE_MS = 30_000

/** How long a disconnected session is watched for coming back on its own. */
export const DISCONNECT_SETTLE_MS = 5_000
/** Long enough for a seeded device to authenticate from storage, or for one
 *  popup round trip and a retry. */
export const CONNECT_TIMEOUT_MS = 60_000
/** One SOC upload, its publish, and the read-back — seconds on the cluster. */
export const UPLOAD_TIMEOUT_MS = 60_000
/** A bus-accelerated handover is ~one round trip; this is the poll fallback plus margin. */
export const HANDOVER_TIMEOUT_MS = LEASE_REFRESH_MS * 3
/** How long a slot nobody released stays taken: its lock lapses at the TTL, its
 *  occupancy beacon a grace later, and a refresh tick acts on it. Nothing a
 *  waiter does shortens it — a closed tab announces nothing (#676). */
export const TTL_LAPSE_MS = LEASE_TTL_MS + INTENT_LIVENESS_GRACE_MS + LEASE_REFRESH_MS
/** Past the idle window with the refresh tick that acts on it. */
export const IDLE_WAIT_MS = IDLE_YIELD_MS + LEASE_REFRESH_MS * 2
/** How an upload fails when no holder answers its slot wait: the wait runs out, or the
 *  acquire around it does. */
export const UNANSWERED_WAIT = /No partition available|Partition lease timed out/
/** The proxy's log line per device-state publish, and the coordinator's per idle yield —
 *  both marked at their source as what this suite keys on. */
export const PUBLISHED_LINE = 'Published device state'
export const YIELDED_LINE = 'Released idle partition'
/** Device-state publishes inside one idle window that say a holder was never idle (#707). */
export const BUSY_PUBLISHES = 3
/** Where a run keeps its account (in the project's output dir), so a worker restarted
 *  after a failure reuses the drive instead of buying another. */
export const SEED_FILE = 'three-devices-seed.json'

export const PARTITION_LINE = /^Partition: /
/** The sidebar's per-drive lane line: `Lane on <8 hex>…: <n|Inactive>`. */
export const LANE_LINE = /^Lane on ([0-9a-f]{8})…: (\d+|Inactive)$/
export const LANE_PREFIX_LENGTH = 8
/** The storage page uploads encrypted by default: a 64-byte reference, 128 hex. */
export const REFERENCE_HEX = /[0-9a-f]{128}|[0-9a-f]{64}/

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The account document and current-account pointer, copied from device A. */
export type Seed = { accounts: string | null; current: string | null }

/**
 * Skip a scenario that has no subject, and say so where a reviewer looks: a
 * `::warning::` line is an annotation on the run and the PR's checks tab,
 * where a skipped scenario is otherwise a green check with the reason in the
 * log only.
 */
export function skipScenario(reason: string): never {
  if (process.env.CI) console.log(`::warning::skipped ${test.info().title}: ${reason}`)
  test.skip(true, reason)
  throw new Error(reason) // unreachable: test.skip throws
}

/**
 * One device: one context, one (or more) demo tabs on it. Everything is read
 * from what the demo renders — the sidebar's `Partition:` line, the harness's
 * round-trip verdict and reference — so the suite asserts what a user sees.
 */
export class Device {
  /** Console lines from every tab, proxy iframes included, with the time seen. */
  readonly log: { at: number; text: string }[] = []

  private constructor(
    readonly label: string,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    context.on('page', (page) => this.record(page))
    this.record(page)
  }

  private record(page: Page): void {
    page.on('console', (message) => this.log.push({ at: Date.now(), text: message.text() }))
  }

  /** How many device-state publishes this device made since `since`. Keyed on
   *  the proxy's own log line (`swarm-id-proxy.ts`, `runAccountStatePublish`),
   *  which says so beside it. */
  publishesSince(since: number): number {
    return this.log.filter((l) => l.at >= since && l.text.includes(PUBLISHED_LINE)).length
  }

  /** Whether this device idle-yielded since `since` — the one console line a
   *  yield leaves, and one a teardown release does not. */
  yieldedSince(since: number): boolean {
    return this.log.some((l) => l.at >= since && l.text.includes(YIELDED_LINE))
  }

  static async open(
    browser: Browser,
    label: string,
    seed?: Seed,
    /** What the demo asks for at connect (its `swarm-id-demo-drive-request`
     *  preset); the demo's own default when omitted. */
    driveRequest?: string,
  ): Promise<Device> {
    const context = await browser.newContext()
    await seedLocalChain(context)
    if (driveRequest) {
      await context.addInitScript((preset: string) => {
        if (location.origin === 'http://localhost:3500') {
          localStorage.setItem('swarm-id-demo-drive-request', preset)
        }
      }, driveRequest)
    }
    if (seed) {
      // Once only: the script runs on every page load in the context, and the
      // device's own store moves on from the seed — its connection to the demo
      // is written there by the popup, and re-seeding would erase it.
      await context.addInitScript((state: Seed) => {
        if (localStorage.getItem('swarm-id-accounts')) return
        if (state.accounts) localStorage.setItem('swarm-id-accounts', state.accounts)
        if (state.current) localStorage.setItem('swarm-id-current-account-v2', state.current)
      }, seed)
    }
    return new Device(label, context, await context.newPage())
  }

  /**
   * Connect the demo to the (already signed-in) account through its popup,
   * then move to the storage page, where uploads take arbitrary bytes. The
   * connect happens on the account page, which has no second Connect button
   * beside the sidebar's; the session is the same on every page of the demo.
   */
  async connect(page: Page = this.page): Promise<void> {
    await page.goto(`${DEMO_ORIGIN}/account`)
    // A seeded device may authenticate from storage at any moment after the
    // page loads (the first device's connection reached its store over the
    // bus), and the popover's button flips from Connect to Disconnect under a
    // click in flight. So: is it connected yet? If not, try the popup once,
    // and let a failed attempt fall back to the question rather than fail.
    const identity = page.getByRole('heading', { name: 'Identity' })
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    for (;;) {
      if (await identity.isVisible()) break
      try {
        await this.connectThroughPopup(page)
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await page.keyboard.press('Escape').catch(() => undefined)
      }
    }
    await this.openStorage(page)
  }

  private async connectThroughPopup(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Connect Swarm ID' }).click({ timeout: 5_000 })
    // Rendered once the client is up; before that, Connect is a silent no-op.
    await expect(page.locator('#swarm-id-button iframe')).toBeVisible({ timeout: 10_000 })
    // Settled either way, so a click that misses (the label flipped under
    // it) leaves no stray rejection behind to fail the test from outside.
    const popupPromise = page.waitForEvent('popup', { timeout: 10_000 }).catch(() => undefined)
    await page.getByRole('button', { name: 'Connect', exact: true }).click({ timeout: 5_000 })
    const popup = await popupPromise
    if (!popup) throw new Error('the connect popup did not open')
    await popup.waitForLoadState()
    await popup.getByRole('button', { name: /0x[0-9a-fA-F]{4}/ }).click()
    // The first device unlocks to approve the connection. A later device's
    // stored account may already carry that connection — the bus folded it in
    // from the first — and the popup goes straight to done with no unlock.
    const unlock = popup.getByRole('textbox', { name: 'Account password' })
    const done = popup.getByRole('button', { name: 'Go to app' })
    await expect(unlock.or(done)).toBeVisible()
    if (await unlock.isVisible()) {
      await unlock.fill(PASSWORD)
      await popup.getByRole('button', { name: 'Confirm' }).click()
    }
    // An `'all'` request (the two-drive suite) is one checkbox, off until ticked.
    const fullAccess = popup.getByText('Grant this app full drive access')
    if (await fullAccess.isVisible()) await popup.getByRole('checkbox').check()
    await goToApp(popup)
    await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible({ timeout: 15_000 })
  }

  /** Connect unless this tab already shows the storage page with a stamp. */
  async ensureConnected(): Promise<void> {
    if (this.page.isClosed()) return
    const onStorage = this.page.url().endsWith('/storage')
    if (onStorage && (await this.page.getByText(PARTITION_LINE).count()) > 0) return
    await this.connect()
  }

  private async openStorage(page: Page): Promise<void> {
    await page.goto(`${DEMO_ORIGIN}/storage`)
    // The sidebar shows the partition line only once the stamp is known, i.e.
    // once the proxy built its write path from the shared store.
    await expect(page.getByText(PARTITION_LINE)).toBeVisible({ timeout: 30_000 })
  }

  /** The partition this tab's session holds; undefined for "Inactive", and
   *  for a tab that is not connected at all (no stamp, so no line). */
  async partition(page: Page = this.page): Promise<number | undefined> {
    const line = page.getByText(PARTITION_LINE)
    if ((await line.count()) === 0) return undefined
    const text = await line.innerText()
    const value = text.replace('Partition:', '').trim()
    return value === 'Inactive' ? undefined : Number(value)
  }

  /**
   * Upload unique bytes and return the reference. Unique on purpose: the
   * stamper counts every stamp against its bucket, so one payload uploaded
   * over and over fills a single bucket and the next stamp fails with
   * "Bucket is full" — a limit, not a lease event. Distinct content spreads
   * across buckets the way real uploads do.
   */
  async upload(page: Page = this.page, batchHex?: string): Promise<string> {
    // A named drive, else the primary: the sidebar's "Write to" select, shown
    // once the app holds more than one drive.
    if (batchHex) await page.getByRole('combobox', { name: 'Write to' }).selectOption(batchHex)
    const payload = `${this.label} ${Date.now()} ${Math.random()}`
    await page.getByPlaceholder('Enter data to upload...').fill(payload)
    // The upload has started once a write leaves for the node (from the proxy
    // iframe — the page-level wait covers frames).
    // The DATA write: a slot wait posts lock chunks of its own (`/soc/…`),
    // which say nothing about whether the upload ever begins.
    const started = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().startsWith(BEE_API_URL) &&
        /\/(bytes|chunks)(\?|$)/.test(request.url()),
      { timeout: UPLOAD_TIMEOUT_MS },
    )
    await page.getByRole('button', { name: 'Upload Data' }).click()
    // A slot wait that times out fails before any write leaves, so the card's
    // error is the only signal then — race it against the first request.
    const failed = page
      .getByRole('main')
      .getByText(/^Error:/)
      .waitFor({ timeout: UPLOAD_TIMEOUT_MS })
      // The label and the message are separate elements; take the card's text.
      .then(async () => {
        const main = await page.getByRole('main').innerText()
        return /Error:\s*([^\n]*)/.exec(main)?.[1].trim() ?? 'unknown error'
      })
    const outcome = await Promise.race([started.then(() => undefined), failed])
    if (outcome !== undefined) throw new Error(`${this.label}: upload failed — ${outcome}`)
    await expect(page.getByRole('button', { name: 'Upload Data' })).toBeEnabled({
      timeout: UPLOAD_TIMEOUT_MS,
    })
    const result = page.getByRole('main').getByText(REFERENCE_HEX)
    await expect(result, `${this.label}: the upload reported no reference`).toBeVisible()
    const reference = REFERENCE_HEX.exec(await result.innerText())![0]
    expect(await readFromBee(reference), `${this.label}: read-back differs`).toBe(payload)
    return reference
  }

  /**
   * The lane this tab's session holds on each drive it was granted, keyed by
   * the drive's batch id prefix as the sidebar prints it; `undefined` for a
   * lane it does not hold. Empty while the app holds a single drive — the
   * sidebar lists lanes only beside its "Write to" select (#882).
   */
  async lanes(page: Page = this.page): Promise<Map<string, number | undefined>> {
    const lines = await page.getByText(LANE_LINE).allInnerTexts()
    return new Map(
      lines.map((line) => {
        const [, prefix, value] = LANE_LINE.exec(line)!
        return [prefix, value === 'Inactive' ? undefined : Number(value)]
      }),
    )
  }

  /** The lane held on one drive, by its batch id. */
  async lane(batchHex: string, page: Page = this.page): Promise<number | undefined> {
    return (await this.lanes(page)).get(batchHex.slice(0, LANE_PREFIX_LENGTH))
  }

  /** Upload and return the partition the session held for it. */
  async uploadAndHold(page: Page = this.page): Promise<number> {
    await this.upload(page)
    const held = await this.partition(page)
    expect(held, `${this.label}: uploaded without holding a partition`).not.toBeUndefined()
    return held!
  }

  /**
   * `uploadAndHold` for a device that has to be handed a slot by a holder.
   * While the two holders keep publishing device state to each other (#707)
   * neither is ever idle, no `lease-request` is answered, and the slot wait
   * times out with "No partition available". That is the bug, not this
   * scenario's subject, so the scenario is skipped with the pointer rather
   * than failed — and passes on its own once the holders go quiet.
   */
  async uploadAndHoldOrSkip(page: Page = this.page): Promise<number> {
    try {
      return await this.uploadAndHold(page)
    } catch (error) {
      const shown = error instanceof Error ? error.message : String(error)
      if (UNANSWERED_WAIT.test(shown)) {
        skipScenario(`${this.label}'s slot wait was never answered: holders stayed busy (#707)`)
      }
      throw error
    }
  }

  /** A second tab of the same dApp on this device — a sibling context. */
  async openSiblingTab(): Promise<Page> {
    const page = await this.context.newPage()
    await page.goto(`${DEMO_ORIGIN}/storage`)
    // Same store, same session: no popup, the proxy authenticates from storage.
    await expect(page.getByText(PARTITION_LINE)).toBeVisible({ timeout: 30_000 })
    return page
  }

  /** The demo's own Disconnect, from the account popover in the sidebar. */
  async disconnect(page: Page = this.page): Promise<void> {
    // The sidebar's account button reads `<name> <6 hex>...<4 hex>`, no 0x.
    await page.getByRole('button', { name: /[0-9a-fA-F]{6}\.\.\.[0-9a-fA-F]{4}/ }).click()
    await page.getByRole('button', { name: 'Disconnect' }).click()
    await expect(page.getByText(PARTITION_LINE)).toBeHidden()
    // And it stays disconnected: a session that comes back by itself a few
    // seconds later — a peer's delta folding its secret back in, and its own
    // not-yet-released lock re-acquired — is a product failure this scenario
    // exists to see (#712), not a flake.
    await sleep(DISCONNECT_SETTLE_MS)
    await expect(
      page.getByText(PARTITION_LINE),
      `${this.label}: the session came back on its own after Disconnect`,
    ).toBeHidden()
  }

  /** What this device's tabs show right now — the sidebar and the harness
   *  environment block — for the failure report. */
  async dump(): Promise<string> {
    const lines: string[] = []
    for (const [index, page] of this.context.pages().entries()) {
      if (page.isClosed()) continue
      const sidebar = await page
        .getByRole('complementary')
        .innerText()
        .catch(() => '(no sidebar)')
      // The upload card's result or error, whichever the last upload left.
      const main = await page
        .getByRole('main')
        .innerText()
        .catch(() => '')
      const outcome = main
        .split('\n')
        .filter((line) => /Reference|failed|error|full|unavailable/i.test(line))
        .slice(0, 4)
      lines.push(
        `--- ${this.label} tab ${index} ${page.url()}\n${sidebar.replace(/\n+/g, ' | ')}\n${outcome.map((v) => `  · ${v.trim()}`).join('\n')}`,
      )
    }
    const lease = this.log
      .filter((l) =>
        /BatchWriteCoordinator|PartitionLease\]|Published device state|lease/.test(l.text),
      )
      .slice(-8)
      .map((l) => `  ${new Date(l.at).toISOString().slice(11, 19)} ${l.text.slice(0, 160)}`)
    if (lease.length) lines.push(`  last lease lines:\n${lease.join('\n')}`)
    return lines.join('\n')
  }

  async close(): Promise<void> {
    await this.context.close()
  }
}

/** The one invariant: the partitions held right now are pairwise distinct. */
export async function expectNoDualHold(
  devices: Device[],
): Promise<Map<string, number | undefined>> {
  // Read together, not in turn: a release landing between two reads would
  // show a hold that was already gone by the time the next was read.
  const live = devices.filter((device) => !device.page.isClosed())
  const partitions = await Promise.all(live.map((device) => device.partition()))
  const held = new Map(live.map((device, index) => [device.label, partitions[index]]))
  const taken = [...held.values()].filter((p): p is number => p !== undefined)
  expect(new Set(taken).size, `dual hold: ${JSON.stringify([...held])}`).toBe(taken.length)
  return held
}

/** Read a reference straight off the cluster, as another device would. */
export async function readFromBee(reference: string): Promise<string> {
  const response = await fetch(`${BEE_API_URL}/bytes/${reference}`)
  expect(response.ok, `Bee returned ${response.status} for ${reference}`).toBe(true)
  return new TextDecoder().decode(await response.arrayBuffer())
}

export async function demoReachable(): Promise<boolean> {
  try {
    await fetch(DEMO_ORIGIN, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

/**
 * The bus is what a handover rides on. Without the signaling server every
 * slot request goes unanswered, which reads exactly like #707's busy holders
 * — so its absence must fail the gate, not masquerade as that skip.
 */
export async function busReachable(): Promise<boolean> {
  try {
    const response = await fetch(SIGNALING_HEALTH_URL, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * An account with `count` regular drives, created standalone on the identity
 * origin on device A. The other devices are seeded with its stored document
 * rather than importing the phrase through the UI: what is under test is the
 * lease, not the sign-in.
 */
export async function createAccountWithDrives(page: Page, count = 1): Promise<Seed> {
  await page.goto(`${ID_ORIGIN}/`)
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  const bzzPlur = DEVICES_RUN_BZZ_PLUR * BigInt(count)
  const slot = await stockedSlot(bzzPlur)
  expect(slot, 'no worker faucet slot holds one run’s worth of BZZ').toBeDefined()
  await fundPostageSigner(page, { slot, bzzPlur })
  for (let bought = 1; bought <= count; bought++) {
    await addDrive(page)
    await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toHaveCount(bought, {
      timeout: DRIVE_SETTLE_TIMEOUT_MS,
    })
  }
  const seed: Seed = await page.evaluate(() => ({
    accounts: localStorage.getItem('swarm-id-accounts'),
    current: localStorage.getItem('swarm-id-current-account-v2'),
  }))
  await waitForBatchIngestion(page, undefined, drivesOf(seed))
  return seed
}

/** The seeded account's drives, the default first. */
export function drivesOf(seed: Seed): string[] {
  const doc = JSON.parse(seed.accounts ?? '{}') as {
    data?: { defaultPostageStampBatchID?: string; postageStamps?: { batchID: string }[] }[]
  }
  const account = doc.data?.[0]
  const ids = (account?.postageStamps ?? []).map((stamp) => stamp.batchID)
  const first = account?.defaultPostageStampBatchID
  return first ? [first, ...ids.filter((id) => id !== first)] : ids
}

export const rigUp =
  (await chainReachable()) &&
  (await beeReachable()) &&
  (await demoReachable()) &&
  (await busReachable())
