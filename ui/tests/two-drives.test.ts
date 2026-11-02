// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Two drives, two devices, real browsers (#882).
 *
 * An app granted every drive of the account (`'all'`) writes to two of them,
 * naming the drive on each write, and a second device of the same account
 * takes a lane on each. Each drive's lease is its own: the primary's comes
 * with the session and any other drive's with the first write that names it,
 * a write to one drive moves nothing on the other, one device's lanes are
 * released together on its disconnect while the other's stay, and a drive
 * leaving the grant tears down its lane on every device and nothing else. The lanes are
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
  LANE_PREFIX_LENGTH,
  LEASE_REFRESH_MS,
  type Seed,
  TTL_LAPSE_MS,
  UPLOAD_TIMEOUT_MS,
  createAccountWithDrives,
  rigUp,
  sleep,
} from './devices-rig'
import { TWO_DRIVES_SEED_FILE } from './global-setup-devices'
import { ID_ORIGIN } from './helpers'

/** Where a run keeps its account, so a worker restarted after a failure
 *  reuses the drives instead of buying two more. */
/** A grant change reaches the other device over the account bus: one
 *  round trip, with the poll fallback as margin. */
const GRANT_PROPAGATION_MS = LEASE_REFRESH_MS * 3

/** The lanes held on one drive are pairwise distinct across devices. */
async function expectNoDualHoldOn(
  driveId: string,
  devices: Device[],
): Promise<Map<string, number | undefined>> {
  const live = devices.filter((device) => !device.page.isClosed())
  const lanes = await Promise.all(live.map((device) => device.lane(driveId)))
  const held = new Map(live.map((device, index) => [device.label, lanes[index]]))
  const taken = [...held.values()].filter((lane): lane is number => lane !== undefined)
  expect(
    new Set(taken).size,
    `dual hold on ${driveId.slice(0, LANE_PREFIX_LENGTH)}: ${JSON.stringify([...held])}`,
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
  /** The app's two drive ids: the account's default, which is the app's primary, and the other. */
  let D1: string
  let D2: string
  const all = () => [A, B]

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(TTL_LAPSE_MS * 2 + UPLOAD_TIMEOUT_MS * 3)
    const seedPath = join(test.info().project.outputDir, TWO_DRIVES_SEED_FILE)
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
    await A.ensureConnected()
    ;[D1, D2] = await A.driveIds()
    expect(D2, 'the app was granted one drive, not two').toBeDefined()
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

  /** The lane a device holds on a drive, once the sidebar shows one. */
  async function laneHeld(device: Device, driveId: string): Promise<number> {
    await expect
      .poll(() => device.lane(driveId), {
        message: `${device.label} holds no lane on ${driveId.slice(0, LANE_PREFIX_LENGTH)}`,
        timeout: LEASE_REFRESH_MS,
      })
      .not.toBeUndefined()
    return (await device.lane(driveId))!
  }

  // Holders idle past IDLE_YIELD_MS let go once a rival is known, so every
  // comparison below follows an upload closely rather than a gap.

  test('A holds the primary from connect, and takes the second drive on its first write to it', async () => {
    await A.connect()
    // The primary's write path is built with the session, and its lane with
    // it; the other drive's is built on the first write that names it.
    const onD1 = await laneHeld(A, D1)
    expect(await A.lane(D2), 'a lane on the second drive before any write to it').toBeUndefined()

    // An unnamed write goes to the primary, and touches no other drive.
    await A.upload()
    expect(await A.lane(D1)).toBe(onD1)
    expect(await A.lane(D2), 'a write to the primary took a lane on the other').toBeUndefined()

    await A.upload(A.page, D2)
    await laneHeld(A, D2)
    expect(await A.lane(D1), 'the second drive’s lane moved the first’s').toBe(onD1)
  })

  test("B takes its own lane on each drive, leaving A's where they are", async () => {
    await A.ensureConnected()
    await B.connect()
    // A holds both, freshly: what B does next must not move either.
    await A.upload()
    await A.upload(A.page, D2)
    const aOnD1 = await laneHeld(A, D1)
    const aOnD2 = await laneHeld(A, D2)

    await B.upload()
    const bOnD1 = await laneHeld(B, D1)
    expect(bOnD1, 'B took the lane A holds on the first drive').not.toBe(aOnD1)
    expect(
      await B.lane(D2),
      'B’s write to the first drive took a lane on the second',
    ).toBeUndefined()
    expect(await A.lane(D1), 'A lost its lane on the first drive to B').toBe(aOnD1)
    expect(await A.lane(D2), 'B’s write to the first drive moved A’s lane on the second').toBe(
      aOnD2,
    )

    await B.upload(B.page, D2)
    expect(await laneHeld(B, D2), 'B took the lane A holds on the second drive').not.toBe(aOnD2)
    expect(await A.lane(D2), 'A lost its lane on the second drive to B').toBe(aOnD2)
    await expectNoDualHoldOn(D1, all())
    await expectNoDualHoldOn(D2, all())
  })

  // Not proven here: that the disconnect RELEASES A's lanes. A reclaims its own
  // lock either way, so that takes a third device waiting on the slot, as in
  // three-devices' disconnect scenario.
  test("A's disconnect leaves B's lanes, and A comes back on its own", async () => {
    for (const device of all()) await device.ensureConnected()
    // Every lane held, freshly.
    await A.upload()
    await A.upload(A.page, D2)
    await B.upload()
    await B.upload(B.page, D2)
    const aOnD2 = await laneHeld(A, D2)
    const bOnD1 = await laneHeld(B, D1)
    const bOnD2 = await laneHeld(B, D2)

    await A.disconnect()
    expect(await B.lane(D1), 'A’s disconnect moved B’s lane on the first drive').toBe(bOnD1)
    expect(await B.lane(D2), 'A’s disconnect moved B’s lane on the second drive').toBe(bOnD2)

    // Back, and writing to the second drive: a lane of its own there again,
    // beside B's.
    await A.connect()
    await A.upload(A.page, D2)
    const back = await laneHeld(A, D2)
    expect(back, 'A came back onto the lane B holds').not.toBe(bOnD2)
    expect(back).toBe(aOnD2)
    await expectNoDualHoldOn(D1, all())
    await expectNoDualHoldOn(D2, all())
  })

  test('a drive leaving the grant tears down its lane on every device, and only that lane', async () => {
    for (const device of all()) await device.ensureConnected()
    // Both hold both, freshly: the lanes on the first drive are what must survive.
    await A.upload(A.page, D2)
    await B.upload(B.page, D2)
    await A.upload()
    await B.upload()
    const aOnD1 = await laneHeld(A, D1)
    const bOnD1 = await laneHeld(B, D1)
    await laneHeld(A, D2)
    await laneHeld(B, D2)

    // The user takes full drive access away in Swarm ID, on device A: the app
    // falls back to the account default, and the second drive leaves the grant.
    const swarmId = await A.context.newPage()
    try {
      await swarmId.goto(`${ID_ORIGIN}/`)
      await swarmId.getByRole('tab', { name: 'Apps' }).click()
      await swarmId.getByRole('button', { name: 'Swarm ID Demo' }).click()
      // The app's page grants on the spot: unticking saves it, and swaps the
      // box for the drive rows, so `uncheck()` would wait on a box that is gone.
      await swarmId.getByRole('checkbox', { name: /full drive access/ }).click()
      await expect(swarmId.getByText('Permissions saved')).toBeVisible()
    } finally {
      await swarmId.close()
    }

    // One drive left on each device — device A's store by the storage event,
    // device B's over the bus: the sidebar's per-drive lanes go with its
    // select, and the primary's partition line says what each still holds.
    for (const device of all()) {
      await expect
        .poll(async () => (await device.lanes()).size, {
          message: `${device.label} still lists two drives`,
          timeout: GRANT_PROPAGATION_MS,
        })
        .toBe(0)
    }
    expect(await A.partition(), 'A lost its lane on the drive that stayed').toBe(aOnD1)
    expect(await B.partition(), 'B lost its lane on the drive that stayed').toBe(bOnD1)
    // And the drive that stayed still writes, for both, where they were.
    await A.upload()
    await B.upload()
    expect(await A.partition()).toBe(aOnD1)
    expect(await B.partition()).toBe(bOnD1)
  })
})
