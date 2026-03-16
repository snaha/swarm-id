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
  onCancel: () => void
  mocked?: boolean // For testing - returns dummy batches
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
 * Parse and validate a batch event from the widget
 */
function parseBatchEvent(data: unknown): BatchEvent | undefined {
  if (typeof data !== 'object' || data === undefined || data === null) {
    return undefined
  }

  const obj = data as Record<string, unknown>

  if (obj.event !== 'batch') {
    return undefined
  }

  if (
    typeof obj.batchId !== 'string' ||
    typeof obj.depth !== 'number' ||
    typeof obj.amount !== 'string' ||
    typeof obj.blockNumber !== 'string'
  ) {
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
    depth: obj.depth,
    amount: obj.amount,
    blockNumber: obj.blockNumber,
  }
}

/**
 * Open the stamp purchase widget in a popup window
 *
 * @param options - Purchase options including destination address and callbacks
 */
export function openStampPurchaseWidget(options: PurchaseStampOptions): void {
  const { destination, onSuccess, onError, onCancel, mocked } = options

  const url = buildWidgetUrl(destination, mocked)
  const popup = window.open(url, 'stamp-purchase', POPUP_FEATURES)

  if (!popup) {
    onError(new Error('Failed to open widget popup. Please allow popups for this site.'))
    return
  }

  let completed = false
  let mockTimeout: ReturnType<typeof setTimeout> | undefined

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

    // Check for error event
    if ((typeof data === 'object' && data !== undefined) || data !== null) {
      const obj = data as Record<string, unknown>
      if (obj.event === 'error') {
        completed = true
        cleanup()
        popup.close()
        onError(new Error(String(obj.message || 'Widget error')))
        return
      }

      // Check for finish event (user closed widget without completing)
      if (obj.event === 'finish') {
        completed = true
        cleanup()
        popup.close()
        onCancel()
        return
      }
    }
  }

  // Check if popup was closed
  const checkClosed = setInterval(() => {
    if (popup.closed && !completed) {
      completed = true
      cleanup()
      onCancel()
    }
  }, 500)

  // Cleanup function - clears all listeners and timers
  const cleanup = () => {
    window.removeEventListener('message', handleMessage)
    clearInterval(checkClosed)
    if (mockTimeout) {
      clearTimeout(mockTimeout)
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
        // Generate a 64-character hex batch ID
        const batchId =
          crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 32)
        onSuccess({
          event: 'batch',
          batchId,
          depth: 20,
          amount: '10000000000',
          blockNumber: '0x' + Math.floor(Date.now() / 1000).toString(16),
        })
      }
    }, MOCK_DELAY_MS)
  }
}

/**
 * Generate a random signer key (32 bytes)
 */
export function generateSignerKey(): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}
