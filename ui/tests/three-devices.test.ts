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
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  BUSY_PUBLISHES,
  Device,
  HANDOVER_TIMEOUT_MS,
  IDLE_WAIT_MS,
  LEASE_REFRESH_MS,
  PEER_YIELD_MIN_IDLE_MS,
  type Seed,
  TTL_LAPSE_MS,
  UNANSWERED_WAIT,
  UPLOAD_TIMEOUT_MS,
  createAccountWithDrives,
  expectNoDualHold,
  rigUp,
  skipScenario,
  sleep,
} from './devices-rig'
import { THREE_DEVICES_SEED_FILE } from './global-setup-devices'

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
    test.setTimeout(TTL_LAPSE_MS * 2 + UPLOAD_TIMEOUT_MS * 3)
    // Playwright replaces the worker after a failed test and runs this hook
    // again; the drive bought the first time is reused rather than bought
    // again, which is what keeps a run with failures from draining the faucet.
    const seedPath = join(test.info().project.outputDir, THREE_DEVICES_SEED_FILE)
    if (existsSync(seedPath)) {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed
      // The previous worker's contexts are gone but their locks and beacons
      // are not: a partition they held stays taken until the TTL and the
      // beacon grace lapse. Three new devices arriving before that find both
      // slots held and every scenario fails for the same reason.
      await sleep(TTL_LAPSE_MS)
      A = await Device.open(browser, 'A', seed)
      B = await Device.open(browser, 'B', seed)
      C = await Device.open(browser, 'C', seed)
      return
    }
    A = await Device.open(browser, 'A')
    const seed = await createAccountWithDrives(A.page)
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
        skipScenario(`${device.label} published ${busy}× during the idle window (#707)`)
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
    // holder yield. The holder that yields may be B rather than A — then B
    // holds nothing to release, and the scenario has no subject (#798: the
    // assertion below once compared A's slot with `undefined`). One more
    // upload puts B back: C, just served, is inside the peer-yield window,
    // so the idle holder that yields is A.
    await B.uploadAndHoldOrSkip()
    await C.uploadAndHoldOrSkip()
    if ((await B.partition()) === undefined) await B.uploadAndHoldOrSkip()
    const before = await expectNoDualHold(all())
    const pB = before.get('B')
    if (pB === undefined || before.get('C') === undefined) {
      skipScenario(
        `B and C did not both hold before B's disconnect: ${JSON.stringify([...before])}`,
      )
    }

    // A waits for a slot while B disconnects. The mechanism under test is the
    // teardown release: B's slot is freed at once and its `lease-released`
    // wakes A's wait. The other way A could be served — C idle-yielding to
    // A's request — is kept out by C having just uploaded (inside the
    // peer-yield window when A asks), and is detected if it happens anyway:
    // a yield is the one release that logs, a teardown release does not.
    const asked = Date.now()
    const aUpload = A.upload()
    await B.disconnect()
    await aUpload
    if (C.yieldedSince(asked)) {
      skipScenario('C yielded to the request before B’s release could be told apart')
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
    test.setTimeout(TTL_LAPSE_MS + UPLOAD_TIMEOUT_MS * 5)
    // C holds a partition and then goes away without a teardown — no release
    // sentinel, no `lease-released`, only a socket close the room notices.
    await C.uploadAndHoldOrSkip()
    await C.close()

    // Nothing A or B does brings C's slot back sooner, so wait the lapse out
    // first. Uploading through it instead (#798) spent the budget on trading
    // the one free slot: an idle release on one side and a cold re-claim on
    // the other took longer than what was left once C's lock had lapsed — and
    // when A and B share a home partition the re-claim contends for the same
    // slot before the other is tried. A and B idle-release meanwhile; a cold
    // acquire finding C's expired lock is what "comes back by TTL" means.
    await sleep(TTL_LAPSE_MS)
    // Each uploads: the first takes a free slot, the second finds the other one
    // free. One round is the expectation; a second covers an acquire that read
    // C's lock a beat before it lapsed and waited it out.
    let held = new Map<string, number | undefined>()
    for (let round = 0; round < 2; round++) {
      for (const device of [A, B]) {
        await device.upload().catch((error: Error) => {
          if (!UNANSWERED_WAIT.test(error.message)) throw error
        })
      }
      held = await expectNoDualHold([A, B])
      if (held.get('A') !== undefined && held.get('B') !== undefined) break
    }
    expect(
      held.get('A') !== undefined && held.get('B') !== undefined,
      `A and B never both held after C closed: ${JSON.stringify([...held])}`,
    ).toBe(true)
  })
})
