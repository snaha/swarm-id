/**
 * Debounced Utilization Uploader
 *
 * Batches multiple utilization updates together to minimize upload frequency.
 * Uses a per-batch debounce mechanism with configurable delay.
 */

import type { DirtyChunkTracker } from "../utils/batch-utilization"

/**
 * Default debounce delay in milliseconds
 */
const DEFAULT_DEBOUNCE_DELAY_MS = 1000

/**
 * Pending upload task for a batch
 */
interface PendingUpload {
  /** Dirty chunk tracker accumulating changes */
  tracker: DirtyChunkTracker

  /** Timer ID for debounce */
  timerId: ReturnType<typeof setTimeout> | undefined

  /** Upload function to execute */
  uploadFn: () => Promise<void>

  /** Promise resolvers for awaiting completion */
  promise: { resolve: () => void; reject: (error: Error) => void }
}

/**
 * Debounced uploader for batch utilization data
 *
 * Batches multiple updates within a time window and uploads only once.
 * Each batch has its own independent debounce timer.
 */
export class DebouncedUtilizationUploader {
  private pendingUploads = new Map<string, PendingUpload>()
  private defaultDelay: number

  /**
   * Create a new debounced uploader
   * @param delay - Debounce delay in milliseconds (default: 1000ms = 1s)
   */
  constructor(delay = DEFAULT_DEBOUNCE_DELAY_MS) {
    this.defaultDelay = delay
  }

  /**
   * Schedule an upload for a batch (debounced)
   *
   * If multiple updates occur within the debounce window, they are merged
   * and only one upload is performed.
   *
   * @param batchId - Batch ID (hex string)
   * @param tracker - Dirty chunk tracker with current changes
   * @param uploadFn - Function to execute upload
   * @param delay - Optional custom delay for this upload
   * @returns Promise that resolves when upload completes
   */
  scheduleUpload(
    batchId: string,
    tracker: DirtyChunkTracker,
    uploadFn: () => Promise<void>,
    delay?: number,
  ): Promise<void> {
    const actualDelay = delay ?? this.defaultDelay

    // Cancel existing timer if present
    const existing = this.pendingUploads.get(batchId)
    if (existing?.timerId) {
      clearTimeout(existing.timerId)
      // Reject old promise
      existing.promise.reject(new Error("Upload cancelled by new request"))
    }

    // Merge with existing tracker or create new
    const mergedTracker = existing?.tracker ?? tracker

    // If we're merging with an existing tracker, copy dirty chunks
    if (existing && existing.tracker !== tracker) {
      for (const chunkIndex of tracker.getDirtyChunks()) {
        mergedTracker.markDirty(chunkIndex * 1024) // Mark any bucket in the chunk
      }
    }

    // Create new promise
    return new Promise<void>((resolve, reject) => {
      // Schedule new upload
      const timerId = setTimeout(async () => {
        try {
          await uploadFn()
          resolve()
        } catch (error) {
          console.error(
            `[DebouncedUploader] Upload failed for batch ${batchId}:`,
            error,
          )
          reject(error instanceof Error ? error : new Error(String(error)))
        } finally {
          // Remove from pending
          this.pendingUploads.delete(batchId)
        }
      }, actualDelay)

      // Store pending upload
      this.pendingUploads.set(batchId, {
        tracker: mergedTracker,
        timerId,
        uploadFn,
        promise: { resolve, reject },
      })
    })
  }

  /**
   * Flush pending upload for a batch immediately (cancel debounce)
   * @param batchId - Batch ID to flush
   */
  async flush(batchId: string): Promise<void> {
    const pending = this.pendingUploads.get(batchId)
    if (!pending) {
      return
    }

    // Cancel timer
    if (pending.timerId) {
      clearTimeout(pending.timerId)
    }

    // Execute immediately
    try {
      await pending.uploadFn()
    } finally {
      this.pendingUploads.delete(batchId)
    }
  }

  /**
   * Flush all pending uploads immediately
   */
  async flushAll(): Promise<void> {
    const batchIds = Array.from(this.pendingUploads.keys())

    await Promise.all(batchIds.map((batchId) => this.flush(batchId)))
  }

  /**
   * Cancel pending upload for a batch (discard changes)
   * @param batchId - Batch ID to cancel
   */
  cancel(batchId: string): void {
    const pending = this.pendingUploads.get(batchId)
    if (!pending) {
      return
    }

    if (pending.timerId) {
      clearTimeout(pending.timerId)
    }

    this.pendingUploads.delete(batchId)
  }

  /**
   * Cancel all pending uploads (discard all changes)
   */
  cancelAll(): void {
    for (const pending of this.pendingUploads.values()) {
      if (pending.timerId) {
        clearTimeout(pending.timerId)
      }
    }

    this.pendingUploads.clear()
  }

  /**
   * Get count of pending uploads
   */
  getPendingCount(): number {
    return this.pendingUploads.size
  }

  /**
   * Check if a batch has a pending upload
   */
  hasPending(batchId: string): boolean {
    return this.pendingUploads.has(batchId)
  }
}
