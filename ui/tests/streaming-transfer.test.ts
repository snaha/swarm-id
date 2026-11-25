// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Streaming transfers across the identity iframe, driven through the demo
 * (#979). A `File` handed to `uploadFile` or `uploadFiles` is pulled across
 * the bridge in pieces of at most 256 KiB, and `downloadFileStream` hands a
 * file back the same way, while a `Uint8Array` still crosses in one message.
 * The demo logs which path each transfer took, counted off the proxy's own
 * messages to its window, and its "Stream File to Disk" saves the stream;
 * with the save picker taken away, as here, it falls back to a Blob download,
 * which Playwright catches.
 *
 * Runs under `playwright.streaming.config.ts` with the device rig: one
 * device, one drive, a real cluster.
 *
 *   pnpm dev:local                      # cluster, chain, solver, apps
 *   pnpm test:streaming                 # chromium
 *
 * Skips when the chain, the Bee cluster, the demo or the signaling server is
 * not up.
 */
import { type Page, expect, test } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  Device,
  REFERENCE_HEX,
  type Seed,
  UPLOAD_TIMEOUT_MS,
  WARM_UP_TIMEOUT_MS,
  createAccountWithDrives,
  rigUp,
  sleep,
} from './devices-rig'
import { STREAMING_TRANSFER_SEED_FILE } from './global-setup-devices'

const MIB = 1024 * 1024
/** The bridge's bound on one piece, as the proxy sets it (`STREAM_PIECE_SIZE` in the lib) */
const PIECE_BYTES = 256 * 1024
/** Big enough that a whole-file message would be one large clone; sixteen pieces at the bound */
const FILE_BYTES = 4 * MIB
const FILE_NAME = 'streamed.bin'
/** The folder's larger file spans pieces; its index document fits in one. */
const FOLDER_DATA_BYTES = 2 * PIECE_BYTES + 1
const FOLDER_FILES = 2

/** How often the device's console is read for the demo's log lines */
const LOG_POLL_MS = 250
/** The demo logs to the console as `[info] …` / `[error] …` (`log.svelte.ts`). */
const FAILED_LINE = /^\[error\] (Upload failed|Folder upload failed|Streaming download failed)/
const UPLOADED_LINE = /Upload successful! Reference: ([0-9a-f]+)/
const UPLOAD_STREAMED = /Upload path: streamed — (\d+) pieces? pulled across the iframe/
const UPLOAD_BUFFERED = /Upload path: buffered — sent in one message/
const DOWNLOAD_STREAMED = /Download path: streamed — (\d+) pieces? pulled across the iframe/

/**
 * The first line the demo logged since `since` that matches `pattern`. A
 * transfer the demo reports as failed ends the wait at once, with its message.
 */
async function logLine(
  device: Device,
  pattern: RegExp,
  since: number,
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lines = device.log.filter((line) => line.at >= since)
    for (const { text } of lines) {
      const match = pattern.exec(text)
      if (match) return match
    }
    const failed = lines.find(({ text }) => FAILED_LINE.test(text))
    if (failed) throw new Error(`${device.label}: ${failed.text}`)
    if (Date.now() > deadline) throw new Error(`no log line matching ${pattern} in ${timeoutMs} ms`)
    await sleep(LOG_POLL_MS)
  }
}

/** Click an upload button once the session will stamp: a fresh drive warms up first (#924). */
async function clickWhenEnabled(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true })
  await expect(button).toBeEnabled({ timeout: WARM_UP_TIMEOUT_MS })
  await button.click()
}

test.describe('streaming transfers across the iframe', () => {
  test.skip(
    !rigUp,
    'requires the chain, the Bee cluster, the demo and the signaling server (pnpm dev:local)',
  )

  let A: Device

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(UPLOAD_TIMEOUT_MS * 5 + WARM_UP_TIMEOUT_MS)
    // Playwright replaces the worker after a failed test and runs this hook
    // again: the drive bought the first time is reused rather than bought
    // again. The previous worker's device may still hold one of the drive's
    // two partitions until its lease lapses; a single new device takes the other.
    const seedPath = join(test.info().project.outputDir, STREAMING_TRANSFER_SEED_FILE)
    if (existsSync(seedPath)) {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed
      A = await Device.open(browser, 'A', seed)
    } else {
      A = await Device.open(browser, 'A')
      const seed = await createAccountWithDrives(A.page)
      mkdirSync(dirname(seedPath), { recursive: true })
      writeFileSync(seedPath, JSON.stringify(seed))
    }
    // No save picker, so "Stream File to Disk" takes its Blob fallback, which
    // ends in a download event rather than a native dialog nobody can answer.
    await A.context.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
    })
    await A.connect()
  })

  // Playwright reads fixtures off the destructured first argument; none are needed here.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus || !A || A.page.isClosed()) return
    console.log(await A.dump())
    const demoLines = A.log.filter(({ text }) => /^\[(info|error|warn)\] /.test(text)).slice(-12)
    console.log(demoLines.map(({ text }) => `  ${text.slice(0, 200)}`).join('\n'))
    await testInfo.attach('A.png', {
      body: await A.page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)),
      contentType: 'image/png',
    })
  })

  test.afterAll(async () => {
    if (A) await A.close().catch(() => undefined)
  })

  // The contrast that keeps the count honest: bytes already in memory are not pulled.
  test('a Uint8Array goes over in one message, with no pulls', async () => {
    test.setTimeout(UPLOAD_TIMEOUT_MS + WARM_UP_TIMEOUT_MS)
    const page = A.page
    const uploadStart = Date.now()
    // The data card encodes its text and calls `uploadData` with the bytes.
    await page.getByPlaceholder('Enter data to upload...').fill(`streaming ${Date.now()}`)
    await clickWhenEnabled(page, 'Upload Data')
    await logLine(A, UPLOAD_BUFFERED, uploadStart)
    await logLine(A, UPLOADED_LINE, uploadStart)
    expect(
      A.log.some(({ at, text }) => at >= uploadStart && UPLOAD_STREAMED.test(text)),
      'a buffered upload was logged as streamed',
    ).toBe(false)
  })

  test('a 4 MiB file streams up in pieces, and streams back to disk byte-identical', async () => {
    test.setTimeout(UPLOAD_TIMEOUT_MS * 3 + WARM_UP_TIMEOUT_MS)
    const page = A.page
    const original = randomBytes(FILE_BYTES)

    const uploadStart = Date.now()
    // The file card's input; the folder card's carries `webkitdirectory`.
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name: FILE_NAME,
      mimeType: 'application/octet-stream',
      buffer: original,
    })
    await clickWhenEnabled(page, 'Upload File')
    const [, pulled] = await logLine(A, UPLOAD_STREAMED, uploadStart)
    // At least one piece per 256 KiB: none was over the bridge's bound.
    expect(
      Number(pulled),
      'the upload crossed in fewer pieces than its size allows',
    ).toBeGreaterThanOrEqual(FILE_BYTES / PIECE_BYTES)
    const [, reference] = await logLine(A, UPLOADED_LINE, uploadStart)
    expect(reference).toMatch(REFERENCE_HEX)

    // The page hands the reference to the download card beside it.
    await expect(
      page.getByPlaceholder('Reference (64 or 128 hex chars)', { exact: true }),
    ).toHaveValue(reference)
    const downloadStart = Date.now()
    const saved = page.waitForEvent('download', { timeout: UPLOAD_TIMEOUT_MS })
    await page.getByRole('button', { name: 'Stream File to Disk' }).click()
    const download = await saved
    expect(download.suggestedFilename()).toBe(FILE_NAME)
    const back = await readFile(await download.path())
    expect(back.length).toBe(FILE_BYTES)
    expect(back.equals(original), 'the file read back differs from the one uploaded').toBe(true)

    const [, pieces] = await logLine(A, DOWNLOAD_STREAMED, downloadStart)
    expect(Number(pieces)).toBeGreaterThanOrEqual(FILE_BYTES / PIECE_BYTES)
    await logLine(A, /Saved streamed\.bin \(4\.00 MB\) as a Blob download/, downloadStart)
  })

  test('a folder’s files are pulled one at a time, each in pieces', async () => {
    test.setTimeout(UPLOAD_TIMEOUT_MS * 2 + WARM_UP_TIMEOUT_MS)
    const page = A.page
    const folder = test.info().outputPath('folder')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>streamed</title>')
    writeFileSync(join(folder, 'data.bin'), randomBytes(FOLDER_DATA_BYTES))

    const uploadStart = Date.now()
    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(folder)
    await clickWhenEnabled(page, 'Upload Folder')
    const [line, pulled] = await logLine(
      A,
      new RegExp(`${UPLOAD_STREAMED.source}, from ${FOLDER_FILES} files`),
      uploadStart,
    )
    // One piece for the index document, three for the data file.
    expect(Number(pulled), line).toBe(1 + Math.ceil(FOLDER_DATA_BYTES / PIECE_BYTES))
    await logLine(A, /Folder uploaded! Reference: [0-9a-f]+/, uploadStart)
  })
})
