// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multichain Widget Service
 *
 * Integrates with the Ethersphere multichain widget for purchasing postage stamps.
 * The widget handles blockchain transactions and sends batch creation results via postMessage.
 */

const WIDGET_BASE_URL = 'https://fund.bzz.limo/'
const ALLOWED_ORIGINS = ['https://fund.bzz.limo', 'https://fund.ethswarm.org']
const POPUP_FEATURES = 'popup,width=500,height=700'

/**
 * Batch event from the multichain widget
 */
export interface BatchEvent {
  event: 'batch'
  batchId: string // "0xfe48d..." (64 hex chars)
  depth: number // e.g., 21
  amount: string // "10453363201" (PLUR units)
  blockNumber: string // "0x2a828b8" (hex)
}

/**
 * Options for opening the stamp purchase widget
 */
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
  mocked?: boolean // For testing - returns dummy batches
  mockError?: boolean // For testing - simulate error instead of success
}

/**
 * Build the widget URL with parameters
 */
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

/**
 * Check if the message origin is from an allowed widget domain
 */
function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin)
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
 * number, else `undefined`. The real widget's message-field types are not
 * contractually guaranteed, so we accept either form.
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Coerce a value that may arrive as a string, number, or bigint into its string
 * form (used for `amount`/`blockNumber`, which downstream re-parse as BigInt /
 * integer).
 */
function toStringField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
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
  const batchIdHex = obj.batchId.startsWith('0x') ? obj.batchId.slice(2) : obj.batchId
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

/**
 * Open the stamp purchase widget in a popup window
 *
 * @param options - Purchase options including destination address and callbacks
 */
export function openStampPurchaseWidget(options: PurchaseStampOptions): void {
  const { destination, onSuccess, onError, onCancel, onUnconfirmedClose, mocked, mockError } =
    options

  const url = buildWidgetUrl(destination, mocked)
  const popup = window.open(url, 'stamp-purchase', POPUP_FEATURES)

  if (!popup) {
    onError(new Error('Failed to open widget popup. Please allow popups for this site.'))
    return
  }

  // How long to keep listening for a trailing `batch` message after the popup
  // is observed closed, before concluding the close was unconfirmed. The widget
  // can post the result just before/after closing its window.
  const CLOSE_GRACE_MS = 1_500

  let completed = false
  let mockTimeout: ReturnType<typeof setTimeout> | undefined
  let closeGraceTimer: ReturnType<typeof setTimeout> | undefined

  // Handle messages from the widget
  const handleMessage = (event: MessageEvent) => {
    // Validate origin
    if (!isAllowedOrigin(event.origin)) {
      return
    }

    const data = event.data

    // Check for batch event
    const batchEvent = parseBatchEvent(data)
    if (batchEvent) {
      completed = true
      cleanup()
      popup.close()
      onSuccess(batchEvent)
      return
    }

    const obj = coerceObject(data)

    // Check for error event
    if (obj?.event === 'error') {
      completed = true
      cleanup()
      popup.close()
      onError(new Error(String(obj.message || 'Widget error')))
      return
    }

    // Check for finish event (user explicitly closed the widget without
    // completing a purchase) — a genuine cancel.
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
  // but its message was never recognized (e.g. the widget didn't auto-close and
  // the user closed it manually). NOT a clean cancel — the caller must not
  // discard a possible purchase.
  const concludeUnconfirmedClose = () => {
    if (completed) return
    completed = true
    cleanup()
    onUnconfirmedClose()
  }

  // Check if popup was closed
  const checkClosed = setInterval(() => {
    if (popup.closed && !completed && closeGraceTimer === undefined) {
      // Stop polling but keep the message listener alive for the grace window,
      // so a `batch`/`finish` message arriving right as the popup closes is
      // still handled.
      clearInterval(checkClosed)
      closeGraceTimer = setTimeout(concludeUnconfirmedClose, CLOSE_GRACE_MS)
    }
  }, 500)

  // Cleanup function - clears all listeners and timers
  const cleanup = () => {
    window.removeEventListener('message', handleMessage)
    clearInterval(checkClosed)
    if (mockTimeout) {
      clearTimeout(mockTimeout)
    }
    if (closeGraceTimer) {
      clearTimeout(closeGraceTimer)
    }
  }

  window.addEventListener('message', handleMessage)

  // In mocked mode, simulate a response after a delay
  // The external widget's mocked mode doesn't send postMessage events,
  // so we simulate the response locally
  if (mocked) {
    const MOCK_DELAY_MS = 10_000
    mockTimeout = setTimeout(() => {
      if (!completed) {
        completed = true
        cleanup()
        popup.close()

        if (mockError) {
          onError(new Error('Mock error: Purchase failed'))
        } else {
          // Generate a 64-character hex batch ID
          const batchId =
            crypto.randomUUID().replace(/-/g, '') +
            crypto.randomUUID().replace(/-/g, '').slice(0, 32)
          onSuccess({
            event: 'batch',
            batchId,
            depth: 20,
            amount: '10000000000',
            blockNumber: '0x' + Math.floor(Date.now() / 1000).toString(16),
          })
        }
      }
    }, MOCK_DELAY_MS)
  }
}
