// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Saving a download stream to disk. Where the browser has a save picker
 * (Chromium's File System Access API) the stream is piped into the chosen
 * file as it arrives, and nothing holds the whole file; elsewhere it is
 * collected into a Blob and handed to the browser's own download.
 */

/** How long the browser has to start a Blob download before its URL is revoked */
const OBJECT_URL_LIFETIME_MS = 1000

/** `window.showSaveFilePicker`, which TypeScript's DOM types leave out */
type SaveFilePicker = (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>

/**
 * How a save went: written through the picker, downloaded as a Blob (with why
 * the picker was not used), or cancelled in the picker before anything was
 * asked of the proxy. `download` is what `open` resolved to.
 */
export type SaveOutcome<T> =
  | { path: 'picker'; elapsedMs: number; download: T }
  | { path: 'blob'; elapsedMs: number; reason: string; download: T }
  | { path: 'cancelled' }

function savePicker(): SaveFilePicker | undefined {
  const picker = (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
  return typeof picker === 'function' ? (picker as SaveFilePicker).bind(window) : undefined
}

function errorName(error: unknown): string | undefined {
  return error instanceof DOMException ? error.name : undefined
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS)
}

/**
 * Save the stream `open` resolves to, suggesting `name` (a Blob download
 * takes the download's own name when it has one). The picker opens
 * first, while the click's user activation is fresh, and the download is
 * asked for only once a file is chosen: a stream nobody reads is ended by the
 * proxy, and a picker opened after a slow lookup can be refused. A picker
 * that refuses for any reason but a cancel falls back to the Blob download.
 */
export async function saveStream<
  T extends { stream: ReadableStream<Uint8Array>; name?: string },
>(
  name: string,
  open: () => Promise<T>,
): Promise<SaveOutcome<T>> {
  const picker = savePicker()
  let reason = 'this browser has no save picker'
  if (picker) {
    let handle: FileSystemFileHandle | undefined
    try {
      handle = await picker({ suggestedName: name })
    } catch (error) {
      if (errorName(error) === 'AbortError') return { path: 'cancelled' }
      reason = `the save picker refused: ${error instanceof Error ? error.message : String(error)}`
    }
    if (handle) {
      const writable = await handle.createWritable()
      let download: T
      try {
        download = await open()
      } catch (error) {
        await writable.abort(error)
        throw error
      }
      const startedAt = performance.now()
      await download.stream.pipeTo(writable)
      return { path: 'picker', elapsedMs: performance.now() - startedAt, download }
    }
  }
  const download = await open()
  const startedAt = performance.now()
  const blob = await new Response(download.stream).blob()
  downloadBlob(blob, download.name ?? name)
  return { path: 'blob', elapsedMs: performance.now() - startedAt, reason, download }
}

/** How a finished save went, as the demo logs it. */
export function describeSave(outcome: Exclude<SaveOutcome<unknown>, { path: 'cancelled' }>): string {
  return outcome.path === 'picker'
    ? 'through the save picker'
    : `as a Blob download (${outcome.reason})`
}
