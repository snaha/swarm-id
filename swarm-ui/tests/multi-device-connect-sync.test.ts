// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// DIAGNOSTIC spec (not a CI gate). End-to-end multi-device check:
//   Device 1 — create synced agent, connect demo, assign a mutable node batch,
//              publish. Confirms the connectedApp reaches Swarm.
//   Device 2 — fresh profile, SAME seed, distinctive name. Checks whether it
//              restores device-1's published state (account name + apps).
//
// Requires the local dev cluster (servers reused). Uses a mutable, node-usable
// batch + the node-owner (Queen) signer, and points the app at the local bee
// (default is the public gateway, which lacks local batches).

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const TEST_SEED_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DEMO_URL = 'http://localhost:3000'
const SWARM_UI_URL = 'http://localhost:5174'

const MUTABLE_BATCH = 'a23d39692b725f4dd9370c235eaaed62511596de3fc3bf1a23cf5784cb20cf40'
const QUEEN_SIGNER = '566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9'

function pipeConsole(prefix: string, target: Page, sink: string[]) {
  target.on('console', (m: ConsoleMessage) => {
    const line = `${prefix} ${m.type()}: ${m.text()}`
    sink.push(line)
    console.log(line)
  })
  target.on('pageerror', (e) => {
    console.log(`${prefix} pageerror: ${e.message}`)
  })
}

async function openAgentConnectPopup(page: Page) {
  await page.goto(DEMO_URL)
  await expect(page.locator('button:has-text("Connect Swarm ID")')).toBeVisible()
  await page.click('button:has-text("Connect Swarm ID")')
  await expect(page.locator('text=Library API')).toBeVisible()
  await page.click('#popover-agent-signup')
  await expect(page.locator('#swarm-id-button')).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(1000)
  const popupPromise = page.waitForEvent('popup', { timeout: 15000 })
  await page.locator('div.bg-popover button:text-is("Connect")').click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  return popup
}

async function syncedAgentConnectSkipStamp(popup: Page, accountName: string) {
  await popup.click('a:has-text("Sign up as agent")')
  await popup.waitForURL(/agent\/new/)
  await popup.fill('[name="account-name"]', accountName)
  await popup.locator('.account-type .select').click()
  await popup.click('text=Synced')
  await popup.fill('textarea.seed-phrase-input', TEST_SEED_PHRASE)
  await expect(popup.getByText('Valid seed phrase')).toBeVisible()
  await popup.click('button:has-text("Create Agent Account")')
  await popup.waitForURL(/identity\/new/)
  await expect(popup.locator('text=Create identity')).toBeVisible()
  await popup.click('button:has-text("Confirm")')
  await popup.waitForURL(/stamps\/account\/new/)
  await popup.click('button.link:has-text("Skip this step")')
  await popup.waitForURL(/connect/)
  await expect(popup.getByText('All set!')).toBeVisible({ timeout: 30000 })
}

function injectLocalBee(page: Page) {
  return page.evaluate(() => {
    localStorage.setItem(
      'swarm-id-network-settings',
      JSON.stringify({
        beeNodeUrl: 'http://localhost:1633',
        gnosisRpcUrl: 'http://localhost:9545',
      }),
    )
  })
}

function readStores(page: Page) {
  return page.evaluate(() => {
    const get = (k: string) => {
      try {
        return JSON.parse(localStorage.getItem(k) || 'null')
      } catch {
        return null
      }
    }
    const accounts = get('swarm-id-accounts')
    const apps = get('swarm-id-connected-apps')
    return {
      accountName: accounts?.data?.[0]?.name,
      defaultStamp: accounts?.data?.[0]?.defaultPostageStampBatchID,
      appUrls: (apps?.data ?? []).map((a: { appUrl: string }) => a.appUrl),
    }
  })
}

test.describe('DIAGNOSTIC multi-device connect sync', () => {
  test('device1 publishes connectedApp; does device2 (same seed) restore it?', async ({
    browser,
  }) => {
    test.setTimeout(180000)
    const logs: string[] = []

    // ---------------- Device 1 ----------------
    const ctx1 = await browser.newContext()
    const page1 = await ctx1.newPage()
    pipeConsole('[D1]', page1, logs)

    await page1.goto(SWARM_UI_URL)
    await page1.evaluate(() => localStorage.clear())
    await page1.goto(DEMO_URL)
    await page1.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('swarm-demo-storage-verified', 'true')
    })

    const popup = await openAgentConnectPopup(page1)
    pipeConsole('[D1 popup]', popup, logs)
    await syncedAgentConnectSkipStamp(popup, 'DEVICE-ONE-NAME')
    try {
      await popup.click('button:has-text("Continue to app")', { timeout: 5000 })
    } catch {
      /* may already be closing */
    }

    // Assign the mutable batch + node owner signer + local bee, then publish.
    await page1.goto(SWARM_UI_URL)
    await injectLocalBee(page1)
    await page1.evaluate(
      ({ batch, signer }) => {
        const acc = JSON.parse(localStorage.getItem('swarm-id-accounts') || 'null')
        acc.data[0].defaultPostageStampBatchID = batch
        localStorage.setItem('swarm-id-accounts', JSON.stringify(acc))
        localStorage.setItem(
          'swarm-id-postage-stamps',
          JSON.stringify({
            version: 1,
            data: [
              {
                batchID: batch,
                signerKey: signer,
                utilization: 0,
                usable: true,
                depth: 20,
                amount: '2903040000',
                bucketDepth: 16,
                blockNumber: 45,
                immutableFlag: false,
                exists: true,
                createdAt: Date.now(),
              },
            ],
          }),
        )
      },
      { batch: MUTABLE_BATCH, signer: QUEEN_SIGNER },
    )
    await page1.goto(`${SWARM_UI_URL}/dev`)
    await page1.click('button:text-is("Sync")')
    await page1.click('button:has-text("Sync All Accounts")')
    await page1.waitForTimeout(15000)
    const d1 = await readStores(page1)
    console.log('[DIAG] device1 stores:', JSON.stringify(d1))

    // ---------------- Device 2 (fresh, same seed, different name) ----------------
    const ctx2 = await browser.newContext()
    const page2 = await ctx2.newPage()
    pipeConsole('[D2]', page2, logs)

    await page2.goto(SWARM_UI_URL)
    await page2.evaluate(() => localStorage.clear())
    await injectLocalBee(page2) // so a restore (if any) hits the local bee
    await page2.goto(DEMO_URL)
    await page2.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('swarm-demo-storage-verified', 'true')
    })
    // Re-inject local bee on :5174 (cleared above on :3000 only affects demo).
    await page2.goto(SWARM_UI_URL)
    await injectLocalBee(page2)

    const popup2 = await openAgentConnectPopup(page2)
    pipeConsole('[D2 popup]', popup2, logs)
    await syncedAgentConnectSkipStamp(popup2, 'DEVICE-TWO-NAME')

    // Read stores on the :5174 origin (where the account/connection live), not
    // the demo origin the popup flow left page2 on.
    await page2.goto(SWARM_UI_URL)
    const d2 = await readStores(page2)
    console.log('[DIAG] device2 stores:', JSON.stringify(d2))
    console.log(
      '[DIAG] RESTORE?',
      d2.accountName === 'DEVICE-ONE-NAME'
        ? 'YES — device2 restored device1 state'
        : `NO — device2 kept its own name "${d2.accountName}" (no restore of published state)`,
    )

    console.log('\n[DIAG] ===== publish / refresh / restore log lines =====')
    for (const l of logs) {
      if (
        /SyncCoordinator|\[Connect\]|StateSync|RefreshAccount|Restore|Updating feed|Verified root|Skipping|invalid batch/i.test(
          l,
        )
      ) {
        console.log(l)
      }
    }

    await ctx1.close()
    await ctx2.close()
  })

  test('Defect A: Devices-tab refresh re-applies connectedApps (not just devices)', async ({
    browser,
  }) => {
    test.setTimeout(180000)
    const logs: string[] = []
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    pipeConsole('[A]', page, logs)

    // Create the synced agent + connect the demo, then publish with a real batch.
    await page.goto(SWARM_UI_URL)
    await page.evaluate(() => localStorage.clear())
    await page.goto(DEMO_URL)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('swarm-demo-storage-verified', 'true')
    })
    const popup = await openAgentConnectPopup(page)
    pipeConsole('[A popup]', popup, logs)
    await syncedAgentConnectSkipStamp(popup, 'REFRESH-TEST')
    try {
      await popup.click('button:has-text("Continue to app")', { timeout: 5000 })
    } catch {
      /* may already be closing */
    }
    await page.goto(SWARM_UI_URL)
    await injectLocalBee(page)
    await page.evaluate(
      ({ batch, signer }) => {
        const acc = JSON.parse(localStorage.getItem('swarm-id-accounts') || 'null')
        acc.data[0].defaultPostageStampBatchID = batch
        localStorage.setItem('swarm-id-accounts', JSON.stringify(acc))
        localStorage.setItem(
          'swarm-id-postage-stamps',
          JSON.stringify({
            version: 1,
            data: [
              {
                batchID: batch,
                signerKey: signer,
                utilization: 0,
                usable: true,
                depth: 20,
                amount: '2903040000',
                bucketDepth: 16,
                blockNumber: 45,
                immutableFlag: false,
                exists: true,
                createdAt: Date.now(),
              },
            ],
          }),
        )
      },
      { batch: MUTABLE_BATCH, signer: QUEEN_SIGNER },
    )
    await page.goto(`${SWARM_UI_URL}/dev`)
    await page.click('button:text-is("Sync")')
    await page.click('button:has-text("Sync All Accounts")')
    await page.waitForTimeout(15000)

    // Simulate a device whose local connectedApps are missing (e.g. it never
    // saw the connection), then trigger the Devices-tab refresh.
    await page.goto(SWARM_UI_URL)
    const identityId = await page.evaluate(() => {
      const identities = JSON.parse(localStorage.getItem('swarm-id-identities') || 'null')
      localStorage.removeItem('swarm-id-connected-apps')
      return identities?.data?.[0]?.id as string | undefined
    })
    console.log('[DIAG] before refresh (apps wiped):', JSON.stringify(await readStores(page)))

    await page.goto(`${SWARM_UI_URL}/identity/${identityId}/devices`)
    await page.waitForTimeout(12000) // allow refresh + apply

    const after = await readStores(page)
    console.log('[DIAG] after Devices-tab refresh:', JSON.stringify(after))
    console.log(
      '[DIAG] DEFECT A FIXED?',
      after.appUrls.includes('http://localhost:3000')
        ? 'YES — refresh re-applied the connected app'
        : 'NO — app still missing after refresh',
    )

    await ctx.close()
  })

  test('Defect B: an open SwarmUI window publishes a connection written by another context', async ({
    browser,
  }) => {
    test.setTimeout(180000)
    const logs: string[] = []
    const ctx = await browser.newContext()

    // Setup: create the account + connection, assign a real batch + local bee.
    const setup = await ctx.newPage()
    pipeConsole('[setup]', setup, logs)
    await setup.goto(SWARM_UI_URL)
    await setup.evaluate(() => localStorage.clear())
    await setup.goto(DEMO_URL)
    await setup.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('swarm-demo-storage-verified', 'true')
    })
    const popup = await openAgentConnectPopup(setup)
    pipeConsole('[setup popup]', popup, logs)
    await syncedAgentConnectSkipStamp(popup, 'DEFECT-B')
    try {
      await popup.click('button:has-text("Continue to app")', { timeout: 5000 })
    } catch {
      /* ignore */
    }
    await setup.goto(SWARM_UI_URL)
    await injectLocalBee(setup)
    // Capture the real connected-apps storage value, assign the stamp, then
    // remove connectedApps so the main window starts without it.
    const realApps = await setup.evaluate(
      ({ batch, signer }) => {
        const acc = JSON.parse(localStorage.getItem('swarm-id-accounts') || 'null')
        acc.data[0].defaultPostageStampBatchID = batch
        localStorage.setItem('swarm-id-accounts', JSON.stringify(acc))
        localStorage.setItem(
          'swarm-id-postage-stamps',
          JSON.stringify({
            version: 1,
            data: [
              {
                batchID: batch,
                signerKey: signer,
                utilization: 0,
                usable: true,
                depth: 20,
                amount: '2903040000',
                bucketDepth: 16,
                blockNumber: 45,
                immutableFlag: false,
                exists: true,
                createdAt: Date.now(),
              },
            ],
          }),
        )
        const apps = localStorage.getItem('swarm-id-connected-apps')
        localStorage.removeItem('swarm-id-connected-apps')
        return apps
      },
      { batch: MUTABLE_BATCH, signer: QUEEN_SIGNER },
    )
    await setup.close()

    // Open the persistent "main window" (no connected apps yet).
    const mainWindow = await ctx.newPage()
    pipeConsole('[mainWindow]', mainWindow, logs)
    await mainWindow.goto(SWARM_UI_URL)
    await mainWindow.waitForTimeout(1000)
    console.log('[DIAG] main window before:', JSON.stringify(await readStores(mainWindow)))

    // A different same-origin context (simulating the connect popup) writes the
    // connection → the main window's storageManager.subscribe should fire,
    // reload, and publish.
    const writer = await ctx.newPage()
    await writer.goto(SWARM_UI_URL)
    await writer.evaluate((apps) => {
      if (apps) localStorage.setItem('swarm-id-connected-apps', apps)
    }, realApps)

    await mainWindow.waitForTimeout(12000) // debounce (2s) + publish
    const after = await readStores(mainWindow)
    console.log('[DIAG] main window after:', JSON.stringify(after))
    const published = logs.some((l) => /\[mainWindow\].*(Updating feed|Verified root)/i.test(l))
    console.log(
      '[DIAG] DEFECT B FIXED?',
      published && after.appUrls.includes('http://localhost:3000')
        ? 'YES — open window published the connection without a manual refresh'
        : `NO — published=${published}, appUrls=${JSON.stringify(after.appUrls)}`,
    )

    await ctx.close()
  })

  test('Revocation propagates: a revoke on device 1 supersedes an active copy on refresh', async ({
    browser,
  }) => {
    test.setTimeout(180000)
    const logs: string[] = []
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    pipeConsole('[D1]', page, logs)

    // Setup: create the account + connection, assign a real batch + local bee.
    await page.goto(SWARM_UI_URL)
    await page.evaluate(() => localStorage.clear())
    await page.goto(DEMO_URL)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('swarm-demo-storage-verified', 'true')
    })
    const popup = await openAgentConnectPopup(page)
    pipeConsole('[D1 popup]', popup, logs)
    await syncedAgentConnectSkipStamp(popup, 'REVOKE-TEST')
    try {
      await popup.click('button:has-text("Continue to app")', { timeout: 5000 })
    } catch {
      /* ignore */
    }
    await page.goto(SWARM_UI_URL)
    await injectLocalBee(page)
    await page.evaluate(
      ({ batch, signer }) => {
        const acc = JSON.parse(localStorage.getItem('swarm-id-accounts') || 'null')
        acc.data[0].defaultPostageStampBatchID = batch
        localStorage.setItem('swarm-id-accounts', JSON.stringify(acc))
        localStorage.setItem(
          'swarm-id-postage-stamps',
          JSON.stringify({
            version: 1,
            data: [
              {
                batchID: batch,
                signerKey: signer,
                utilization: 0,
                usable: true,
                depth: 20,
                amount: '2903040000',
                bucketDepth: 16,
                blockNumber: 45,
                immutableFlag: false,
                exists: true,
                createdAt: Date.now(),
              },
            ],
          }),
        )
      },
      { batch: MUTABLE_BATCH, signer: QUEEN_SIGNER },
    )

    const publish = async () => {
      await page.goto(`${SWARM_UI_URL}/dev`)
      await page.click('button:text-is("Sync")')
      await page.click('button:has-text("Sync All Accounts")')
      await page.waitForTimeout(10000)
    }

    // 1) Publish with the app active.
    await publish()

    // 2) Revoke on device 1 (tombstone) and publish it.
    await page.goto(SWARM_UI_URL)
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('swarm-id-connected-apps') || 'null')
      const now = Date.now()
      raw.data = raw.data.map((a: Record<string, unknown>) => ({
        ...a,
        revokedAt: now,
        updatedAt: now,
        connectedUntil: undefined,
        appSecret: undefined,
        lastConnectedAt: 0,
      }))
      localStorage.setItem('swarm-id-connected-apps', JSON.stringify(raw))
    })
    await publish()

    // 3) Simulate a device that still has the app ACTIVE (older updatedAt), then
    //    refresh — the newer remote tombstone must win.
    await page.goto(SWARM_UI_URL)
    const identityId = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('swarm-id-connected-apps') || 'null')
      raw.data = raw.data.map((a: Record<string, unknown>) => ({
        ...a,
        revokedAt: undefined,
        updatedAt: 1,
        lastConnectedAt: 1,
        connectedUntil: Date.now() + 3_600_000,
        appSecret: 'still-active-on-device-2',
      }))
      localStorage.setItem('swarm-id-connected-apps', JSON.stringify(raw))
      const ids = JSON.parse(localStorage.getItem('swarm-id-identities') || 'null')
      return ids?.data?.[0]?.id as string | undefined
    })

    await page.goto(`${SWARM_UI_URL}/identity/${identityId}/devices`)
    await page.waitForTimeout(12000) // refresh + apply

    const demo = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('swarm-id-connected-apps') || 'null')
      return (raw?.data ?? []).find((a: { appUrl: string }) => a.appUrl === 'http://localhost:3000')
    })
    console.log('[DIAG] after revoke+refresh, demo entry:', JSON.stringify(demo))
    console.log(
      '[DIAG] REVOCATION PROPAGATED?',
      demo && demo.revokedAt
        ? 'YES — tombstone won; app hidden from UI'
        : `NO — entry=${JSON.stringify(demo)}`,
    )

    await ctx.close()
  })
})
