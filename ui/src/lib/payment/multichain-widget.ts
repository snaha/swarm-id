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

// The deployment carrying the `window.opener` fix (ethersphere/multichain-widget
// 85eb9c37) — without it the widget posts every event to `window.parent`, which
// in a popup is the popup itself, so nothing ever reaches us (#342). The older
// origins stay allowed so a later redeploy of either keeps working.
const WIDGET_BASE_URL = 'https://swarmbucks.eth.limo/'
const ALLOWED_ORIGINS = [
  'https://swarmbucks.eth.limo',
  'https://fund.bzz.limo',
  'https://fund.ethswarm.org',
]
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
  // The user backed out before any money moved — no `payment` event was seen, so
  // there is nothing to lose by returning to the form.
  onCancel: () => void
  // The widget ended without a batch we could record, but a `payment` event told
  // us money is already in flight. The caller MUST NOT treat this as a clean
  // cancel: the purchase may still settle on-chain.
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
 * The message out of a widget `error` event.
 *
 * The deployed build posts `{event: 'error', error: <err>}`, where `<err>` is a
 * string or a structured-cloned `Error`; `message` is accepted too, since the
 * widget's shapes are not a documented contract. Reading only `message` turned
 * every real failure into the generic fallback below — the one string a user can
 * do nothing with, on the screen where they most need to know what went wrong.
 */
function widgetErrorMessage(obj: Record<string, unknown>): string {
  for (const candidate of [obj.error, obj.message]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate
    }
    const nested = (candidate as { message?: unknown } | undefined)?.message
    if (typeof nested === 'string' && nested.trim() !== '') {
      return nested
    }
  }
  return 'Widget error'
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
   * Abort the purchase from OUR UI (e.g. the pending dialog's Cancel): detaches
   * the listeners, and closes the popup only while nothing has been paid or
   * settled — once money is in flight the popup has to run to the end, so it is
   * left open. Fires no callback — the caller initiated it.
   *
   * @returns `true` when the popup was left running because the user's money is
   *   already in it. That exit is otherwise silent — no callback, and the
   *   purchase may still settle after our UI is gone — so the caller is the one
   *   place that can say so (and then recover it via "Use existing batch").
   *   `false` on a clean back-out, and on any later call: cancelling is
   *   terminal, so a second one (a dialog's `onDestroy` after its own close)
   *   reports nothing.
   */
  cancel: () => boolean
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
        // The mock never moves money.
        return false
      },
    }
  }

  const url = buildWidgetUrl(destination)
  const popup = window.open(url, 'stamp-purchase', POPUP_FEATURES)

  if (!popup) {
    onError(new Error('Failed to open widget popup. Please allow popups for this site.'))
    return { cancel: () => false }
  }

  // A `batch` event was recorded — onSuccess has already fired.
  let settled = false
  // A `payment` event arrived: the user's money is in flight and the widget's
  // pipeline must be allowed to run to the end, whatever we do with our UI.
  let paid = false
  // Terminal: listeners are detached and no further callback may fire.
  let finished = false
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
      // Record the batch, but leave the popup running: `create-batch` is not the
      // last step — the trailing transfer steps sweep leftover xDAI off the
      // widget's temporary wallet back to the owner. Closing here would strand
      // it. The widget closes itself once it posts `finish`.
      settled = true
      settle(onSuccess, onError, batchEvent)
      return
    }

    const obj = coerceObject(data)

    // Money is committed from here on: the funds reach the temporary wallet
    // whether or not the widget stays open, so a close is no longer a clean
    // back-out and we must never force one.
    if (obj?.event === 'payment') {
      paid = true
      return
    }

    // Error event
    if (obj?.event === 'error') {
      const error = new Error(widgetErrorMessage(obj))
      // Money in flight: the same rule `cancel()` and `finish` follow — never
      // force a popup shut while the user's funds sit on the temporary wallet,
      // because the pipeline that sweeps them back runs client-side there
      // (#550). The listener stays attached too: the widget recovers in-popup
      // (its `payment` events carry a `resumed` flag), and a detached listener
      // would lose the batch that recovery settles. If the popup does end
      // without one, the close poll concludes it as unconfirmed.
      if (paid && !settled) {
        onError(error)
        return
      }
      finished = true
      cleanup()
      popup.close()
      onError(error)
      return
    }

    // The flow ran to the end. Not a cancel — the widget posts nothing when the
    // user aborts, so `finish` only ever means completion.
    if (obj?.event === 'finish') {
      finished = true
      cleanup()
      popup.close()
      if (!settled) {
        // Completed without a batch we could record: paid means the purchase may
        // still be out there, unpaid means nothing was lost.
        if (paid) {
          onUnconfirmedClose()
        } else {
          onCancel()
        }
      }
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

  // The popup went away without a `finish`. Harmless once the batch is recorded;
  // ambiguous once money moved; a plain back-out otherwise.
  const concludeClose = () => {
    if (finished) {
      return
    }
    finished = true
    cleanup()
    if (settled) {
      return
    }
    if (paid) {
      onUnconfirmedClose()
      return
    }
    onCancel()
  }

  const checkClosed = setInterval(() => {
    if (popup.closed && !finished && closeGraceTimer === undefined) {
      // Stop polling but keep the message listener alive for the grace window,
      // so a `batch`/`finish` message arriving right as the popup closes is
      // still handled.
      clearInterval(checkClosed)
      closeGraceTimer = setTimeout(concludeClose, CLOSE_GRACE_MS)
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
      if (finished) {
        return false
      }
      finished = true
      cleanup()
      // Never close a popup that still has the user's money in it: the pipeline
      // runs client-side there, and killing it strands funds on the temporary
      // wallet (#550). Detach only and let it finish on its own.
      if (!paid && !settled) {
        popup.close()
        return false
      }
      // Settled means the batch is already recorded and only the sweep is left,
      // which needs no warning. Paid-but-unsettled is the exit worth telling the
      // user about.
      return !settled
    },
  }
}
