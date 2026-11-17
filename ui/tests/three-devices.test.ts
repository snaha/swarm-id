// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Three devices, two write partitions, real browsers.
 *
 * The browser counterpart of `lib/test/live/three-device-acquire-handoff.test.ts`:
 * the same account on three `BrowserContext`s — separate storage, separate
 * device ids, one signaling server — each driving the demo the way a person
 * does, with the partition read off the demo's own sidebar and every upload a
 * round trip through the demo's Safari-check harness. Taking a partition
 * over the account bus, the handover, the reload, the second tab, the
 * disconnect and the closed tab all run for real, with production timings.
 *
 * Every step ends on the one invariant it all exists for: no two contexts
 * hold the same partition. The scenarios are ordered and share the devices —
 * each starts from where the previous one left the partitions — so the file
 * is serial and runs on one worker (`playwright.devices.config.ts`).
 *
 * Not part of the everyday e2e run: `.github/workflows/three-devices.yml` runs it on a PR that
 * touches the partition seams, nightly on main, before every npm publish (a red
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
  ABSENCE_LAPSE_MS,
  ACQUIRE_TIMEOUT_MS,
  Device,
  HANDOVER_TIMEOUT_MS,
  LEASE_STOP_MS,
  LEASE_WAIT_MS,
  MAX_SILENT_TICKS,
  PEER_YIELD_MIN_IDLE_MS,
  type Seed,
  TICK_MS,
  UNANSWERED_WAIT,
  UPLOAD_TIMEOUT_MS,
  createAccountWithDrives,
  expectNoDualHold,
  isDataWrite,
  rigUp,
  skipScenario,
  sleep,
} from './devices-rig'
import { THREE_DEVICES_SEED_FILE } from './global-setup-devices'

// Not `serial`: a scenario that fails must not hide the ones after it — the
// point of the run is a verdict per scenario. Each one re-establishes what it
// needs (`ensureConnected`) and takes the partitions as it finds them.
/** Enough for an upload to still be stamping when its first chunk leaves. */
const MANY_CHUNKS_BYTES = 400_000

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
    test.setTimeout(UPLOAD_TIMEOUT_MS * 5)
    // Playwright replaces the worker after a failed test and runs this hook
    // again; the drive bought the first time is reused rather than bought
    // again, which is what keeps a run with failures from draining the faucet.
    const seedPath = join(test.info().project.outputDir, THREE_DEVICES_SEED_FILE)
    if (existsSync(seedPath)) {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed
      // The previous worker's contexts are gone, and what they held with
      // them: nothing on Swarm says who holds a partition.
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

  test('C arrives with both partitions held: its first upload makes a holder hand one over', async () => {
    for (const device of all()) await device.ensureConnected()
    // Both holders idle past the peer-yield threshold, so either may answer.
    await sleep(PEER_YIELD_MIN_IDLE_MS)
    const before = await expectNoDualHold([A, B])

    await C.connect()
    // C asks for every partition gently first, and nobody moves. Then it asks
    // the holder of its home partition to hand over, then the other one; a
    // holder that is not writing does, and the upload completes on the
    // partition it was handed.
    const pC = await C.uploadAndHoldOrSkip()
    // Whoever held C's partition before has let go of it: it stopped before
    // it answered.
    const previousHolder = [...before].find(([, p]) => p === pC)?.[0]
    if (previousHolder) {
      const device = previousHolder === 'A' ? A : B
      await expect.poll(() => device.partition(), { timeout: HANDOVER_TIMEOUT_MS }).not.toBe(pC)
    }
    await expectNoDualHold(all())
  })

  test('the device that handed over is served on its next upload', async () => {
    for (const device of all()) await device.ensureConnected()
    const before = await expectNoDualHold(all())
    const waiter = [...before].find(([, p]) => p === undefined)?.[0]
    expect(waiter, 'every device holds a partition, nobody handed one over').toBeDefined()
    const waiting = all().find((d) => d.label === waiter)!
    await sleep(PEER_YIELD_MIN_IDLE_MS)

    // Its upload asks the room, an idle holder hands a partition over, and the
    // upload itself completes on it.
    const held = await waiting.uploadAndHoldOrSkip()
    expect(held).toBeDefined()
    await expectNoDualHold(all())
  })

  test('an idle holder keeps its partition: nothing is given up on a timer', async () => {
    for (const device of all()) await device.ensureConnected()
    const before = await expectNoDualHold(all())
    const holders = all().filter((device) => before.get(device.label) !== undefined)
    expect(holders.length, 'nobody holds a partition').toBeGreaterThan(0)

    // Longer than anything that could lapse while the tabs stay open.
    await sleep(LEASE_WAIT_MS * 2)

    for (const device of holders) {
      expect(await device.partition(), `${device.label} let go while idle`).toBe(
        before.get(device.label),
      )
    }
    await expectNoDualHold(all())
  })

  test('a reloaded page holds nothing at first, and takes a partition again by asking', async () => {
    for (const device of all()) await device.ensureConnected()
    // Hold something first; an upload takes a partition when nothing is held.
    await A.uploadAndHoldOrSkip()

    await A.page.reload()
    // The fresh page is a new context in the room: it is owed nothing, and
    // must have been there for the wait before it takes a partition nobody
    // answers for. The one its predecessor held is free by then.
    await expect
      .poll(() => A.partition(), { timeout: ACQUIRE_TIMEOUT_MS + HANDOVER_TIMEOUT_MS })
      .not.toBeUndefined()
    await A.upload()
    await expectNoDualHold(all())
  })

  test('a second tab of one device asks for a partition like any other context, and both tabs upload', async () => {
    for (const device of all()) await device.ensureConnected()
    // Hold something first; an upload takes a partition when nothing is held.
    await A.uploadAndHoldOrSkip()

    const sibling = await A.openSiblingTab()
    /** The partitions the two tabs of A hold are never the same one. */
    const expectTabsApart = async () => {
      const [first, second] = await Promise.all([A.partition(), A.partition(sibling)])
      if (first !== undefined) expect(second, 'both tabs of A hold one partition').not.toBe(first)
    }
    try {
      // A context of its own: it takes a free partition or is handed one, by
      // another device or by the first tab.
      await A.upload(sibling)
      await expectTabsApart()
      await A.upload()
      await expectTabsApart()
      await expectNoDualHold(all())
    } finally {
      await sibling.close()
    }
    // The tab that stays still writes.
    await A.uploadAndHoldOrSkip()
    await expectNoDualHold(all())
  })

  test('a disconnect gives the partition up at once, and a waiting device takes it', async () => {
    for (const device of all()) await device.ensureConnected()
    // Fill both partitions with B and C. Each upload may be handed its
    // partition by whoever holds one, so check who holds afterwards: without
    // B and C both holding, the scenario has no subject (#798).
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

    // A waits for a partition while B disconnects. The mechanism under test
    // is the teardown: B gives its partition up at once and answers A's next
    // claim "free". The other way A could be served — C handing over — is
    // kept out by C having just uploaded (inside the peer-yield window when A
    // asks), and is detected if it happens anyway: a handover is the one way
    // of losing a partition that logs, a disconnect does not.
    const asked = Date.now()
    const aUpload = A.upload()
    await B.disconnect()
    await aUpload
    if (C.lostLaneSince(asked)) {
      skipScenario('C handed over before B’s disconnect could be told apart')
    }
    expect(await A.partition(), 'A did not land on the partition B gave up').toBe(pB)
    await expectNoDualHold([A, C])

    // B reconnects and is served in turn: C or A hands over when asked.
    await B.connect()
    await sleep(PEER_YIELD_MIN_IDLE_MS)
    await B.uploadAndHoldOrSkip()
    await expectNoDualHold(all())
  })

  test('a tab that could not answer for a while keeps its partition, and an upload asked for meanwhile completes', async () => {
    for (const device of all()) await device.ensureConnected()
    const held = await A.uploadAndHoldOrSkip()
    const since = Date.now()

    // Past the time a holder may go unconfirmed, short of the time after
    // which the server drops a silent member.
    const stalled = A.stall(LEASE_STOP_MS + 1_000)
    await sleep(500)
    await A.upload()
    await stalled

    expect(await A.partition(), 'A let go of its partition').toBe(held)
    expect(A.lostLaneSince(since), 'A reported its partition gone').toBe(false)
    await expectNoDualHold(all())
  })

  test('a tab that stops answering in the middle of an upload completes it on the same partition', async () => {
    for (const device of all()) await device.ensureConnected()
    const held = await A.uploadAndHoldOrSkip()
    const since = Date.now()

    // Many chunks, and the thread goes as the first of them leaves: the rest
    // of the stamps and the publish are due when it comes back.
    const firstWrite = A.page.waitForRequest(isDataWrite, { timeout: UPLOAD_TIMEOUT_MS })
    const upload = A.upload(undefined, undefined, MANY_CHUNKS_BYTES)
    await firstWrite
    await A.stall(LEASE_STOP_MS + 1_000)
    await upload

    expect(await A.partition(), 'A let go of its partition').toBe(held)
    expect(A.lostLaneSince(since), 'A reported its partition gone').toBe(false)
    await expectNoDualHold(all())
  })

  test('a tab the server dropped for not answering holds nothing, and an upload asked for meanwhile completes once it is back', async () => {
    for (const device of all()) await device.ensureConnected()
    test.setTimeout(UPLOAD_TIMEOUT_MS * 4)
    await A.uploadAndHoldOrSkip()
    const since = Date.now()

    // Past the server's patience: the connection that comes back is a new
    // one, which holds nothing and has to ask like a newcomer.
    const stalled = A.stall(TICK_MS * (MAX_SILENT_TICKS + 2))
    await sleep(500)
    await A.uploadAndHoldOrSkip()
    await stalled

    expect(A.lostLaneSince(since), 'A was never dropped: the stall tested nothing').toBe(true)
    await expectNoDualHold(all())
  })

  test('a closed tab says nothing: its partition is free once the room has seen it gone for the wait', async () => {
    for (const device of all()) await device.ensureConnected()
    test.setTimeout(ABSENCE_LAPSE_MS + UPLOAD_TIMEOUT_MS * 5)
    // C holds a partition and then goes away without a teardown — only a
    // socket close the room notices.
    await C.uploadAndHoldOrSkip()
    await C.close()

    // Nobody answers for C's partition any more. It is taken once everyone
    // who has not answered has been gone for the wait.
    await sleep(ABSENCE_LAPSE_MS)
    // Each uploads: whoever holds nothing finds a partition free. One round
    // is the expectation; a second covers a claim that was a tick early.
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
