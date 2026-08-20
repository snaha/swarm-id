// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Multichain Widget Service
 *
 * Integrates with the Ethersphere multichain widget for purchasing postage
 * stamps. The widget popup handles the cross-chain crypto payment and the
 * on-chain batch creation, then posts the result back via postMessage. This is
 * the same proven settlement path the legacy UI uses — the URL only carries the
 * batch-owner `destination`; chain / token / amount are chosen inside the popup.
 */
import { strip0x } from '$lib/crypto/hex'

const WIDGET_BASE_URL = 'https://fund.bzz.limo/'
const ALLOWED_ORIGINS = ['https://fund.bzz.limo', 'https://fund.ethswarm.org']
const POPUP_FEATURES = 'popup,width=500,height=700'

/** Batch event posted by the multichain widget once a purchase settles. */
export interface BatchEvent {
  event: 'batch'
  batchId: string // bare 64-hex (parseBatchEvent strips any 0x prefix)
  depth: number // e.g., 21
  amount: string // "10453363201" (PLUR units)
  blockNumber: string // "0x2a828b8" (hex)
}

/** Options for opening the stamp purchase widget. */
export interface PurchaseStampOptions {
  destination: string // Batch owner address (0x...)
  onSuccess: (batch: BatchEvent) => void
  onError: (error: Error) => void
  // The user explicitly backed out of the widget (a `finish` event) without
  // completing a purchase.
  onCancel: () => void
  // The popup closed without us receiving a recognized batch event — ambiguous,
  // because the on-chain purchase may have succeeded but its message was missed
  // (e.g. the widget didn't auto-close and the user closed it manually). The
  // caller MUST NOT treat this as a clean cancel that discards the purchase.
  onUnconfirmedClose: () => void
  mocked?: boolean // For testing - simulate the settlement instead of paying
  mockPopup?: boolean // For testing - also open the widget's `?mocked=true` popup
  mockError?: boolean // For testing - simulate error instead of success
  // For testing - the depth to fabricate. The real widget picks the depth
  // itself, which is why there is no plain `depth` option; the mock takes the
  // size the user asked for so the drive it leaves behind is the one they
  // chose, rather than always a 600 MB one.
  mockDepth?: number
}

/** How long to keep listening for a trailing `batch` message after the popup
 * is observed closed, before concluding the close was unconfirmed. */
const CLOSE_GRACE_MS = 1_500
// Short, visible delay for the /dev mock so the "pending" state is seen before
// the simulated settlement resolves.
const MOCK_DELAY_MS = 1_500
const CLOSE_POLL_MS = 500
// Shape of the mock settlement's fabricated batch event.
const BATCH_ID_HEX_LENGTH = 64
const MOCK_BATCH_DEPTH = 20
const MOCK_BATCH_AMOUNT = '10000000000'
const MS_PER_SECOND = 1_000
const HEX_RADIX = 16

/** Build the widget URL with parameters. */
function buildWidgetUrl(destination: string, mocked?: boolean): string {
  const params = new URLSearchParams({
    mode: 'batch',
    destination,
    intent: 'postage-batch',
    'reserved-slots': '2',
  })

  if (mocked) {
    params.set('mocked', 'true')
  }

  return `${WIDGET_BASE_URL}?${params.toString()}`
}

/** Check if the message origin is from an allowed widget domain. */
function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin)
}

/**
 * Deliver a settled batch to `onSuccess`, routing a callback throw (e.g. the
 * stamp record failing schema validation) to `onError`. Settlement callbacks
 * fire from a message handler / timer where an uncaught throw would vanish and
 * leave the caller's pending UI up forever with the paid batch unrecorded.
 */
function settle(
  onSuccess: (batch: BatchEvent) => void,
  onError: (error: Error) => void,
  batch: BatchEvent,
): void {
  try {
    onSuccess(batch)
  } catch (caught) {
    onError(caught instanceof Error ? caught : new Error('Could not record the purchased batch.'))
  }
}

/**
 * Coerce a postMessage payload into a plain object for inspection. The widget
 * may post a structured-clone object OR a JSON string; both are accepted.
 */
function coerceObject(data: unknown): Record<string, unknown> | undefined {
  let value = data
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Coerce a value that may arrive as a number or a numeric string into a finite
 * number, else `undefined`. The widget's message-field types are not
 * contractually guaranteed, so we accept either form.
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Coerce a value that may arrive as a string, number, or bigint into its string
 * form (used for `amount`/`blockNumber`, which downstream re-parse as BigInt /
 * integer).
 */
function toStringField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return undefined
}

/**
 * Parse and validate a batch event from the widget.
 *
 * Tolerant by design: the external widget's exact message shape is not a
 * documented contract, so we accept the payload as an object OR a JSON string,
 * and accept numeric fields (`depth`/`amount`/`blockNumber`) as either numbers
 * or numeric strings. A too-strict parser silently drops a successful purchase
 * (the message is ignored, then the popup-close path reverts the UI).
 */
export function parseBatchEvent(data: unknown): BatchEvent | undefined {
  const obj = coerceObject(data)
  if (!obj || obj.event !== 'batch') {
    return undefined
  }

  const depth = toFiniteNumber(obj.depth)
  const amount = toStringField(obj.amount)
  const blockNumber = toStringField(obj.blockNumber)

  if (typeof obj.batchId !== 'string' || depth === undefined || !amount || !blockNumber) {
    return undefined
  }

  // Validate batchId format (64 hex chars, optionally prefixed with 0x)
  const batchIdHex = strip0x(obj.batchId)
  if (!/^[0-9a-fA-F]{64}$/.test(batchIdHex)) {
    return undefined
  }

  return {
    event: 'batch',
    batchId: batchIdHex, // Store without 0x prefix
    depth,
    amount,
    blockNumber,
  }
}

/** Handle over an in-flight widget purchase. */
export interface StampPurchaseHandle {
  /**
   * Abort the purchase from OUR UI (e.g. the pending dialog's Cancel): closes
   * the popup and detaches the listeners, so a payment can no longer complete
   * invisibly after the user backed out. Fires no callback — the caller
   * initiated it. No-op once the purchase has already settled.
   */
  cancel: () => void
}

/**
 * Open the stamp purchase widget in a popup window.
 *
 * @param options - Purchase options including destination address and callbacks
 * @returns a handle whose `cancel()` the caller MUST invoke when the user
 *   abandons the flow, otherwise the popup stays open and its message listener
 *   keeps running until the popup is closed by hand.
 */
export function openStampPurchaseWidget(options: PurchaseStampOptions): StampPurchaseHandle {
  const {
    destination,
    onSuccess,
    onError,
    onCancel,
    onUnconfirmedClose,
    mocked,
    mockPopup,
    mockError,
    mockDepth,
  } = options

  // Mocked mode (the /dev toggle): settle locally without a real cross-chain
  // payment. `mockPopup` still opens the widget's own `?mocked=true` popup (which
  // never posts back, so we simulate anyway) — useful to eyeball the popup path
  // in a real browser. Without it, no `window.open` at all, so the mock also
  // works where popups are blocked (previews) or the widget origin is offline.
  // Either way the settlement is simulated after a short, visible delay.
  if (mocked) {
    const popup = mockPopup
      ? window.open(buildWidgetUrl(destination, true), 'stamp-purchase', POPUP_FEATURES)
      : undefined
    const mockTimer = setTimeout(() => {
      popup?.close()
      if (mockError) {
        onError(new Error('Mock error: Purchase failed'))
        return
      }
      // A 64-character hex batch ID, as the real widget would return.
      const batchId = (crypto.randomUUID() + crypto.randomUUID())
        .replace(/-/g, '')
        .slice(0, BATCH_ID_HEX_LENGTH)
      settle(onSuccess, onError, {
        event: 'batch',
        batchId,
        depth: mockDepth ?? MOCK_BATCH_DEPTH,
        amount: MOCK_BATCH_AMOUNT,
        blockNumber: '0x' + Math.floor(Date.now() / MS_PER_SECOND).toString(HEX_RADIX),
      })
    }, MOCK_DELAY_MS)
    return {
      cancel: () => {
        clearTimeout(mockTimer)
        popup?.close()
      },
    }
  }

  const url = buildWidgetUrl(destination)
  const popup = window.open(url, 'stamp-purchase', POPUP_FEATURES)

  if (!popup) {
    onError(new Error('Failed to open widget popup. Please allow popups for this site.'))
    return { cancel: () => undefined }
  }

  let completed = false
  let closeGraceTimer: ReturnType<typeof setTimeout> | undefined

  // Handle messages from the widget
  const handleMessage = (event: MessageEvent) => {
    // Only trust messages from the popup this call opened, on an allowed origin —
    // so another window/tab on the same origin can't spoof widget events.
    if (event.source !== popup || !isAllowedOrigin(event.origin)) {
      return
    }

    const data = event.data

    const batchEvent = parseBatchEvent(data)
    if (batchEvent) {
      completed = true
      cleanup()
      popup.close()
      settle(onSuccess, onError, batchEvent)
      return
    }

    const obj = coerceObject(data)

    // Error event
    if (obj?.event === 'error') {
      completed = true
      cleanup()
      popup.close()
      onError(new Error(String(obj.message || 'Widget error')))
      return
    }

    // Finish event (user explicitly closed the widget without completing a
    // purchase) — a genuine cancel.
    if (obj?.event === 'finish') {
      completed = true
      cleanup()
      popup.close()
      onCancel()
      return
    }

    // An allowed-origin message we didn't recognize. Leave a breadcrumb so a
    // future "purchase succeeded but the UI didn't update" report can be
    // diagnosed without special capture effort.
    console.warn('[multichain-widget] unrecognized message from widget origin', {
      origin: event.origin,
      data,
    })
  }

  // Conclude an ambiguous popup close: the on-chain purchase may have succeeded
  // but its message was never recognized. NOT a clean cancel — the caller must
  // not discard a possible purchase.
  const concludeUnconfirmedClose = () => {
    if (completed) {
      return
    }
    completed = true
    cleanup()
    onUnconfirmedClose()
  }

  const checkClosed = setInterval(() => {
    if (popup.closed && !completed && closeGraceTimer === undefined) {
      // Stop polling but keep the message listener alive for the grace window,
      // so a `batch`/`finish` message arriving right as the popup closes is
      // still handled.
      clearInterval(checkClosed)
      closeGraceTimer = setTimeout(concludeUnconfirmedClose, CLOSE_GRACE_MS)
    }
  }, CLOSE_POLL_MS)

  const cleanup = () => {
    window.removeEventListener('message', handleMessage)
    clearInterval(checkClosed)
    if (closeGraceTimer) {
      clearTimeout(closeGraceTimer)
    }
  }

  window.addEventListener('message', handleMessage)

  return {
    cancel: () => {
      if (completed) {
        return
      }
      // Close the popup BEFORE detaching so the user can't keep paying in a
      // window whose result we would silently drop.
      completed = true
      cleanup()
      popup.close()
    },
  }
}
