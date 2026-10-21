// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Two drives, two devices, real browsers (#882).
 *
 * An app granted every drive of the account (`'all'`) writes to two of them,
 * naming the drive on each write, and a second device of the same account
 * takes a lane on each. Each drive's lease is its own: a lane is taken on the
 * first write to that drive and not before, one device's lanes are released
 * together on its disconnect while the other's stay, and a drive leaving the
 * grant tears down its lane on every device and nothing else. The lanes are
 * read off the demo's sidebar, one line per drive, from `getDrives()`'s
 * `partition`.
 *
 * Runs under `playwright.devices.config.ts` beside `three-devices.test.ts`,
 * with the same rig; the scenarios are ordered and share the devices.
 *
 *   pnpm dev:local                                       # cluster, chain, solver, apps
 *   pnpm test:devices                                    # chromium
 *
 * Skips when the chain, the Bee cluster, the demo or the signaling server is
 * not up.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  Device,
  LEASE_REFRESH_MS,
  type Seed,
  TTL_LAPSE_MS,
  UPLOAD_TIMEOUT_MS,
  createAccountWithDrives,
  drivesOf,
  rigUp,
  sleep,
} from './devices-rig'
import { ID_ORIGIN } from './helpers'

/** Where a run keeps its account, so a worker restarted after a failure
 *  reuses the drives instead of buying two more. */
const SEED_FILE = 'two-drives-seed.json'
/** A grant change reaches the other device over the account bus: one
 *  round trip, with the poll fallback as margin. */
const GRANT_PROPAGATION_MS = LEASE_REFRESH_MS * 3

/** The lanes held on one drive are pairwise distinct across devices. */
async function expectNoDualHoldOn(
  batchHex: string,
  devices: Device[],
): Promise<Map<string, number | undefined>> {
  const live = devices.filter((device) => !device.page.isClosed())
  const lanes = await Promise.all(live.map((device) => device.lane(batchHex)))
  const held = new Map(live.map((device, index) => [device.label, lanes[index]]))
  const taken = [...held.values()].filter((lane): lane is number => lane !== undefined)
  expect(
    new Set(taken).size,
    `dual hold on ${batchHex.slice(0, 8)}: ${JSON.stringify([...held])}`,
  ).toBe(taken.length)
  return held
}

test.describe('two devices on two drives', () => {
  test.skip(
    !rigUp,
    'requires the chain, the Bee cluster, the demo and the signaling server (pnpm dev:local)',
  )

  let A: Device
  let B: Device
  /** The account's two regular drives: the default, which is the app's primary, and the other. */
  let D1: string
  let D2: string
  const all = () => [A, B]

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(TTL_LAPSE_MS * 2 + UPLOAD_TIMEOUT_MS * 3)
    const seedPath = join(test.info().project.outputDir, SEED_FILE)
    let seed: Seed
    if (existsSync(seedPath)) {
      seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed
      // The previous worker's locks and beacons outlive its contexts.
      await sleep(TTL_LAPSE_MS)
      A = await Device.open(browser, 'A', seed, 'all')
    } else {
      A = await Device.open(browser, 'A', undefined, 'all')
      seed = await createAccountWithDrives(A.page, 2)
      mkdirSync(dirname(seedPath), { recursive: true })
      writeFileSync(seedPath, JSON.stringify(seed))
    }
    B = await Device.open(browser, 'B', seed, 'all')
    ;[D1, D2] = drivesOf(seed)
    expect(D2, 'the seeded account holds one drive, not two').toBeDefined()
  })

  // Playwright reads fixtures off the destructured first argument; none are needed here.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return
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
    for (const device of [A, B]) {
      if (device) await device.close().catch(() => undefined)
    }
  })

  test('A takes a lane on each drive, on its first write to that drive', async () => {
    await A.connect()
    // Granted both, writing to neither yet: no lane on either.
    expect(await A.lane(D1)).toBeUndefined()
    expect(await A.lane(D2)).toBeUndefined()

    // An unnamed write goes to the primary, and takes a lane there only.
    await A.upload()
    const onD1 = await A.lane(D1)
    expect(onD1, 'A uploaded without holding a lane on the primary').toBeDefined()
    expect(await A.lane(D2), 'a write to one drive took a lane on the other').toBeUndefined()

    await A.upload(A.page, D2)
    expect(await A.lane(D2), 'A uploaded to the second drive without a lane there').toBeDefined()
    expect(await A.lane(D1), 'the second drive’s lane moved the first’s').toBe(onD1)
  })

  test("B takes its own lane on each drive, leaving A's where they are", async () => {
    await A.ensureConnected()
    const aOnD1 = await A.lane(D1)
    const aOnD2 = await A.lane(D2)

    await B.connect()
    await B.upload()
    const bOnD1 = await B.lane(D1)
    expect(bOnD1, 'B uploaded without holding a lane on the primary').toBeDefined()
    expect(bOnD1, 'B took the lane A holds on the first drive').not.toBe(aOnD1)
    expect(await B.lane(D2), 'B’s first write took a lane on the second drive too').toBeUndefined()
    expect(await A.lane(D1), 'A lost its lane on the first drive to B').toBe(aOnD1)
    expect(await A.lane(D2), 'B’s write to the first drive moved A’s lane on the second').toBe(
      aOnD2,
    )

    await B.upload(B.page, D2)
    expect(await B.lane(D2), 'B took the lane A holds on the second drive').not.toBe(aOnD2)
    expect(await A.lane(D2), 'A lost its lane on the second drive to B').toBe(aOnD2)
    await expectNoDualHoldOn(D1, all())
    await expectNoDualHoldOn(D2, all())
  })

  test("A's disconnect releases both its lanes and leaves B's; A comes back on one drive only", async () => {
    for (const device of all()) await device.ensureConnected()
    const bOnD1 = await B.lane(D1)
    const bOnD2 = await B.lane(D2)
    expect(bOnD1 !== undefined && bOnD2 !== undefined, 'B does not hold both lanes').toBe(true)

    await A.disconnect()
    expect(await B.lane(D1), 'A’s disconnect moved B’s lane on the first drive').toBe(bOnD1)
    expect(await B.lane(D2), 'A’s disconnect moved B’s lane on the second drive').toBe(bOnD2)

    // Back, and writing to the second drive alone: a lane there, none on the
    // first — the first drive's write path is built on its first write, as
    // it was before.
    await A.connect()
    await A.upload(A.page, D2)
    expect(await A.lane(D2), 'A uploaded to the second drive without a lane there').toBeDefined()
    expect(await A.lane(D1), 'A came back holding a lane on a drive it never wrote').toBeUndefined()
    await expectNoDualHoldOn(D2, all())
  })

  test('a drive leaving the grant tears down its lane on every device, and only that lane', async () => {
    for (const device of all()) await device.ensureConnected()
    // Both hold both: A's lane on the first drive is what must survive.
    await A.upload()
    const aOnD1 = await A.lane(D1)
    const bOnD1 = await B.lane(D1)
    expect(
      aOnD1 !== undefined && bOnD1 !== undefined,
      'A and B do not both hold the first drive',
    ).toBe(true)
    expect(await A.lane(D2)).toBeDefined()
    expect(await B.lane(D2)).toBeDefined()

    // The user takes full drive access away in Swarm ID, on device A: the app
    // falls back to the account default, and the second drive leaves the grant.
    const swarmId = await A.context.newPage()
    try {
      await swarmId.goto(`${ID_ORIGIN}/`)
      await swarmId.getByRole('tab', { name: 'Apps' }).click()
      await swarmId.getByRole('button', { name: 'App actions' }).click()
      await swarmId.getByRole('menuitem', { name: 'Permissions' }).click()
      await swarmId.getByRole('checkbox').uncheck()
      await swarmId.getByRole('button', { name: 'Save permissions' }).click()
    } finally {
      await swarmId.close()
    }

    // One drive left: the sidebar's per-drive lanes go with the select, and
    // the primary's partition line says what each device still holds.
    for (const device of all()) {
      await expect
        .poll(async () => (await device.lanes()).size, { timeout: GRANT_PROPAGATION_MS })
        .toBe(0)
    }
    expect(await A.partition(), 'A lost its lane on the drive that stayed').toBe(aOnD1)
    expect(await B.partition(), 'B lost its lane on the drive that stayed').toBe(bOnD1)
    // And the drive that stayed still writes, for both.
    await A.upload()
    await B.upload()
    expect(await A.partition()).toBe(aOnD1)
    expect(await B.partition()).toBe(bOnD1)
  })
})
