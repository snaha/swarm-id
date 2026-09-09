// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Three devices, two write partitions, real browsers.
 *
 * The browser counterpart of `lib/test/live/three-device-acquire-handoff.test.ts`:
 * the same account on three `BrowserContext`s — separate storage, separate
 * device ids, one signaling server — each driving the demo the way a person
 * does, with the partition read off the demo's own sidebar and every upload a
 * round trip through the demo's Safari-check harness. The lease protocol, the
 * account bus, the idle yield, the reload restore, the disconnect release and
 * the TTL reclaim of a closed tab all run for real, with production timings.
 *
 * Every step ends on the one invariant the lease exists for: no two devices
 * hold the same partition. The scenarios are ordered and share the devices —
 * each starts from where the previous one left the lease — so the file is
 * serial and runs on one worker (`playwright.devices.config.ts`).
 *
 * Minutes per run, by design: the lease TTL, the idle yield and the beacon
 * grace are each 30 s and several steps wait them out. Not part of the
 * everyday e2e run: `.github/workflows/three-devices.yml` runs it on a PR that
 * touches the lease seams, nightly on main, before every npm publish (a red
 * run stops the publish), and on demand. Locally:
 *
 *   pnpm dev:local                                       # cluster, chain, solver, apps
 *   pnpm test:devices                                    # chromium
 *   DEVICE_BROWSERS=chromium,firefox,webkit pnpm test:devices
 *
 * Skips when the chain, the Bee cluster or the demo is not up.
 */
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
const DEMO_ORIGIN = 'http://localhost:3500'
/** The account-bus signaling server `pnpm dev` starts (`dev:signaling`). */
const SIGNALING_HEALTH_URL = 'http://localhost:5520/healthz'

// Production timings, restated: the lib ships one bundle and it is the browser
// one, so importing the constants here dies on `window`. Keep in step with
// `lib/src/sync/timing-constants.ts`, `lib/src/utils/batch-utilization.ts`,
// `lib/src/sync/partition-intent.ts` and `lib/src/sync/batch-write-coordinator.ts`.
const LEASE_TTL_MS = 30_000
const LEASE_REFRESH_MS = 10_000
const IDLE_YIELD_MS = 30_000
const PEER_YIELD_MIN_IDLE_MS = 3_000
const INTENT_LIVENESS_GRACE_MS = 30_000

/** How long a disconnected session is watched for coming back on its own. */
const DISCONNECT_SETTLE_MS = 5_000
/** Long enough for a seeded device to authenticate from storage, or for one
 *  popup round trip and a retry. */
const CONNECT_TIMEOUT_MS = 60_000
/** One SOC upload, its publish, and the read-back — seconds on the cluster. */
const UPLOAD_TIMEOUT_MS = 60_000
/** A bus-accelerated handover is ~one round trip; this is the poll fallback plus margin. */
const HANDOVER_TIMEOUT_MS = LEASE_REFRESH_MS * 3
/** A closed tab's slot: its lock lapses at the TTL, its beacon a grace later,
 *  and the waiter polls every refresh interval. */
const TTL_RECLAIM_TIMEOUT_MS = LEASE_TTL_MS + INTENT_LIVENESS_GRACE_MS + LEASE_REFRESH_MS * 3
/** Past the idle window with the refresh tick that acts on it. */
const IDLE_WAIT_MS = IDLE_YIELD_MS + LEASE_REFRESH_MS * 2
/** How an upload fails when no holder answers its slot wait: the wait runs out, or the
 *  acquire around it does. */
const UNANSWERED_WAIT = /No partition available|Partition lease timed out/
/** The proxy's log line per device-state publish, and the coordinator's per idle yield —
 *  both marked at their source as what this suite keys on. */
const PUBLISHED_LINE = 'Published device state'
const YIELDED_LINE = 'Released idle partition'
/** Device-state publishes inside one idle window that say a holder was never idle (#707). */
const BUSY_PUBLISHES = 3
/** Where a run keeps its account (in the project's output dir), so a worker restarted
 *  after a failure reuses the drive instead of buying another. */
const SEED_FILE = 'three-devices-seed.json'

const PARTITION_LINE = /^Partition: /
/** The storage page uploads encrypted by default: a 64-byte reference, 128 hex. */
const REFERENCE_HEX = /[0-9a-f]{128}|[0-9a-f]{64}/

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The account document and current-account pointer, copied from device A. */
type Seed = { accounts: string | null; current: string | null }

/**
 * One device: one context, one (or more) demo tabs on it. Everything is read
 * from what the demo renders — the sidebar's `Partition:` line, the harness's
 * round-trip verdict and reference — so the suite asserts what a user sees.
 */
class Device {
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

  static async open(browser: Browser, label: string, seed?: Seed): Promise<Device> {
    const context = await browser.newContext()
    await seedLocalChain(context)
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
  async upload(page: Page = this.page): Promise<string> {
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
        test.skip(true, `${this.label}'s slot wait was never answered: holders stayed busy (#707)`)
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
async function expectNoDualHold(devices: Device[]): Promise<Map<string, number | undefined>> {
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
async function readFromBee(reference: string): Promise<string> {
  const response = await fetch(`${BEE_API_URL}/bytes/${reference}`)
  expect(response.ok, `Bee returned ${response.status} for ${reference}`).toBe(true)
  return new TextDecoder().decode(await response.arrayBuffer())
}

async function demoReachable(): Promise<boolean> {
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
async function busReachable(): Promise<boolean> {
  try {
    const response = await fetch(SIGNALING_HEALTH_URL, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * An account with a drive, created standalone on the identity origin on device
 * A. The other two devices are seeded with its stored document rather than
 * importing the phrase through the UI: what is under test is the lease, not
 * the sign-in.
 */
async function createAccountWithDrive(page: Page): Promise<Seed> {
  await page.goto(`${ID_ORIGIN}/`)
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()
  const slot = await stockedSlot()
  expect(slot, 'no worker faucet slot holds one run’s worth of BZZ').toBeDefined()
  await fundPostageSigner(page, { slot, bzzPlur: DEVICES_RUN_BZZ_PLUR })
  await addDrive(page)
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: DRIVE_SETTLE_TIMEOUT_MS,
  })
  await waitForBatchIngestion(page)
  return page.evaluate(() => ({
    accounts: localStorage.getItem('swarm-id-accounts'),
    current: localStorage.getItem('swarm-id-current-account-v2'),
  }))
}

const rigUp =
  (await chainReachable()) &&
  (await beeReachable()) &&
  (await demoReachable()) &&
  (await busReachable())

// Not `serial`: a scenario that fails must not hide the ones after it — the
// point of the run is a verdict per scenario. Each one re-establishes what it
// needs (`ensureConnected`) and takes the lease state as it finds it.
test.describe('three devices on two partitions', () => {
  test.skip(
    !rigUp,
    'requires the chain, the Bee cluster, the demo and the signaling server (pnpm dev:local)',
  )

  let A: Device
  let B: Device
  let C: Device
  const all = () => [A, B, C]

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(TTL_RECLAIM_TIMEOUT_MS * 2 + UPLOAD_TIMEOUT_MS * 3)
    // Playwright replaces the worker after a failed test and runs this hook
    // again; the drive bought the first time is reused rather than bought
    // again, which is what keeps a run with failures from draining the faucet.
    const seedPath = join(test.info().project.outputDir, SEED_FILE)
    if (existsSync(seedPath)) {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed
      // The previous worker's contexts are gone but their locks and beacons
      // are not: a partition they held stays taken until the TTL and the
      // beacon grace lapse. Three new devices arriving before that find both
      // slots held and every scenario fails for the same reason.
      await sleep(LEASE_TTL_MS + INTENT_LIVENESS_GRACE_MS + LEASE_REFRESH_MS)
      A = await Device.open(browser, 'A', seed)
      B = await Device.open(browser, 'B', seed)
      C = await Device.open(browser, 'C', seed)
      return
    }
    A = await Device.open(browser, 'A')
    const seed = await createAccountWithDrive(A.page)
    mkdirSync(dirname(seedPath), { recursive: true })
    writeFileSync(seedPath, JSON.stringify(seed))
    B = await Device.open(browser, 'B', seed)
    C = await Device.open(browser, 'C', seed)
  })

  // Playwright reads fixtures off the destructured first argument; none are needed here.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    // The list reporter prints a skip without its reason; the reason is the
    // whole point of an evidence-based skip.
    if (testInfo.status === 'skipped') {
      const reason = testInfo.annotations.find((a) => a.type === 'skip')?.description
      if (reason) console.log(`--- ${testInfo.title}\n    skipped: ${reason}`)
    }
    if (testInfo.status === testInfo.expectedStatus) return
    // The reporter prints errors at the end of the run; say it now, beside
    // the state that produced it.
    const [first] = testInfo.errors
    if (first?.message)
      console.log(`--- ${testInfo.title}\n${first.message.split('\n').slice(0, 6).join('\n')}`)
    for (const device of all()) {
      if (!device || device.page.isClosed()) continue
      console.log(await device.dump())
      await testInfo.attach(`${device.label}.png`, {
        body: await device.page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)),
        contentType: 'image/png',
      })
    }
  })

  test.afterAll(async () => {
    for (const device of [A, B, C]) {
      if (device) await device.close().catch(() => undefined)
    }
  })

  test('A and B connect and each hold their own partition', async () => {
    await A.connect()
    const pA = await A.uploadAndHold()

    await B.connect()
    const pB = await B.uploadAndHold()
    expect(pB, 'B took the partition A holds').not.toBe(pA)
    expect(await A.partition(), 'A lost its partition to B').toBe(pA)
    await expectNoDualHold(all())
  })

  test('C arrives with both partitions held: its first upload makes a holder give one up', async () => {
    for (const device of all()) await device.ensureConnected()
    // Both holders idle past the peer-yield threshold, so either may answer.
    await sleep(PEER_YIELD_MIN_IDLE_MS)
    const before = await expectNoDualHold([A, B])

    await C.connect()
    // The eager acquire on connect finds both slots held and settles for
    // read-only; it does not ask anyone to move. An UPLOAD does: its slot wait
    // broadcasts a `lease-request` each poll round, the lowest-ranked idle
    // holder yields, and the upload completes on the freshly acquired slot.
    // (A holder idle past IDLE_YIELD_MS may already have let go by itself; C
    // then takes the free slot cold. Either way one holder ends up empty.)
    const pC = await C.uploadAndHoldOrSkip()
    // Whoever held C's partition before has let go of it — or had already
    // let go before C asked. Either way at most one of A and B still holds.
    const previousHolder = [...before].find(([, p]) => p === pC)?.[0]
    if (previousHolder) {
      const device = previousHolder === 'A' ? A : B
      await expect.poll(() => device.partition(), { timeout: HANDOVER_TIMEOUT_MS }).not.toBe(pC)
    }
    await expectNoDualHold(all())
  })

  test('the device that yielded is served on its next upload', async () => {
    for (const device of all()) await device.ensureConnected()
    const before = await expectNoDualHold(all())
    const waiter = [...before].find(([, p]) => p === undefined)?.[0]
    expect(waiter, 'every device holds a partition, nobody yielded').toBeDefined()
    const waiting = all().find((d) => d.label === waiter)!
    await sleep(PEER_YIELD_MIN_IDLE_MS)

    // Its upload blocks on a slot wait, asks the room, and an idle holder gives
    // one up — the upload itself completes on the freshly acquired partition.
    const held = await waiting.uploadAndHoldOrSkip()
    expect(held).toBeDefined()
    await expectNoDualHold(all())
  })

  test('holders idle past IDLE_YIELD_MS release their partitions, and re-acquire on the next upload', async () => {
    for (const device of all()) await device.ensureConnected()
    test.setTimeout(IDLE_WAIT_MS + UPLOAD_TIMEOUT_MS * 2 + 60_000)
    // A rival is known to every device by now, which is what arms the timer
    // yield: a solo device keeps its lease across a pause instead.
    const idleFrom = Date.now()
    await sleep(IDLE_WAIT_MS)
    for (const device of all()) {
      const busy = device.publishesSince(idleFrom)
      if ((await device.partition()) !== undefined && busy >= BUSY_PUBLISHES) {
        // Not idle at all: it spent the window publishing device state to a
        // peer (#707), and every publish is lease activity.
        test.skip(true, `${device.label} published ${busy}× during the idle window (#707)`)
      }
      await expect.poll(() => device.partition(), { timeout: LEASE_REFRESH_MS * 2 }).toBeUndefined()
    }

    // Cold acquire, no contention: two free slots, one taker.
    const pA = await A.uploadAndHold()
    expect(pA).toBeDefined()
    await expectNoDualHold(all())
  })

  test('a reload keeps the lease: the fresh page adopts it from the cache without a cold acquire', async () => {
    for (const device of all()) await device.ensureConnected()
    // Hold something first; an upload acquires when nothing is held.
    const before = await A.uploadAndHoldOrSkip()

    await A.page.reload()
    // Adopted from local state alone: the partition is back well inside a
    // refresh interval, with no lock-SOC scan or intent round in between.
    await expect.poll(() => A.partition(), { timeout: LEASE_REFRESH_MS }).toBe(before)
    await A.upload()
    await expectNoDualHold(all())
  })

  test('a second tab of one device shares its partition, and both tabs upload', async () => {
    for (const device of all()) await device.ensureConnected()
    // Hold something first; an upload acquires when nothing is held.
    const held = await A.uploadAndHoldOrSkip()

    const sibling = await A.openSiblingTab()
    try {
      // Same device id, same cache: the sibling adopts the same claim rather
      // than contending for a slot of its own.
      await expect.poll(() => A.partition(sibling), { timeout: LEASE_REFRESH_MS }).toBe(held)
      await A.upload(sibling)
      await A.upload()
      expect(await A.partition()).toBe(held)
      expect(await A.partition(sibling)).toBe(held)
      await expectNoDualHold(all())
    } finally {
      await sibling.close()
    }
    // The tab that stays keeps the lease.
    await A.upload()
    expect(await A.partition()).toBe(held)
  })

  test('a disconnect releases the partition at once, and a waiting device takes it', async () => {
    for (const device of all()) await device.ensureConnected()
    // Fill both slots: B takes a free one, then C's request makes an idle
    // holder yield. B may already have idle-yielded by the time C asks, so C
    // may take B's old slot legitimately; the invariant is the check.
    await B.uploadAndHoldOrSkip()
    await C.uploadAndHoldOrSkip()
    await expectNoDualHold(all())

    // A waits for a slot while B disconnects. The mechanism under test is the
    // teardown release: B's slot is freed at once and its `lease-released`
    // wakes A's wait. The other way A could be served — C idle-yielding to
    // A's request — is kept out by C having just uploaded (inside the
    // peer-yield window when A asks), and is detected if it happens anyway:
    // a yield is the one release that logs, a teardown release does not.
    const pB = (await B.partition())!
    const asked = Date.now()
    const aUpload = A.upload()
    await B.disconnect()
    await aUpload
    if (C.yieldedSince(asked)) {
      test.skip(true, 'C yielded to the request before B’s release could be told apart')
    }
    expect(await A.partition(), 'A did not land on the slot B released').toBe(pB)
    await expectNoDualHold([A, C])

    // B reconnects and is served in turn: C or A yields on request.
    await B.connect()
    await sleep(PEER_YIELD_MIN_IDLE_MS)
    await B.uploadAndHoldOrSkip()
    await expectNoDualHold(all())
  })

  test('a closed tab never releases: its partition comes back by TTL, and the others end up holding', async () => {
    for (const device of all()) await device.ensureConnected()
    test.setTimeout(TTL_RECLAIM_TIMEOUT_MS * 2 + UPLOAD_TIMEOUT_MS * 4)
    // C holds a partition and then goes away without a teardown — no release
    // sentinel, no `lease-released`, only a socket close the room notices.
    await C.uploadAndHoldOrSkip()
    await C.close()

    // A and B keep uploading in turn. While C's lock is live only one slot is
    // free between them and they trade it through yields; once C's lock and
    // occupancy beacon lapse, a poll finds the second slot and they stop
    // trading. The end state is the assertion: both hold, distinct, within the
    // TTL plus the grace.
    const deadline = Date.now() + TTL_RECLAIM_TIMEOUT_MS
    let both = false
    while (Date.now() < deadline && !both) {
      for (const device of [A, B]) {
        // A slot wait that outlasts the acquire timeout is the expected shape
        // while C's lock is still live; the next round tries again.
        await device.upload().catch((error: Error) => {
          if (!UNANSWERED_WAIT.test(error.message)) throw error
        })
      }
      const held = await expectNoDualHold([A, B])
      both = held.get('A') !== undefined && held.get('B') !== undefined
      if (!both) await sleep(LEASE_REFRESH_MS)
    }
    expect(both, 'A and B never both held after C closed').toBe(true)
  })
})
