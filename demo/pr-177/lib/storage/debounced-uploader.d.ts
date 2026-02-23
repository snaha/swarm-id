/**
 * Debounced Utilization Uploader
 *
 * Batches multiple utilization updates together to minimize upload frequency.
 * Uses a per-batch debounce mechanism with configurable delay.
 */
import type { DirtyChunkTracker } from "../utils/batch-utilization";
/**
 * Debounced uploader for batch utilization data
 *
 * Batches multiple updates within a time window and uploads only once.
 * Each batch has its own independent debounce timer.
 */
export declare class DebouncedUtilizationUploader {
    private pendingUploads;
    private defaultDelay;
    /**
     * Create a new debounced uploader
     * @param delay - Debounce delay in milliseconds (default: 1000ms = 1s)
     */
    constructor(delay?: number);
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
    scheduleUpload(batchId: string, tracker: DirtyChunkTracker, uploadFn: () => Promise<void>, delay?: number): Promise<void>;
    /**
     * Flush pending upload for a batch immediately (cancel debounce)
     * @param batchId - Batch ID to flush
     */
    flush(batchId: string): Promise<void>;
    /**
     * Flush all pending uploads immediately
     */
    flushAll(): Promise<void>;
    /**
     * Cancel pending upload for a batch (discard changes)
     * @param batchId - Batch ID to cancel
     */
    cancel(batchId: string): void;
    /**
     * Cancel all pending uploads (discard all changes)
     */
    cancelAll(): void;
    /**
     * Get count of pending uploads
     */
    getPendingCount(): number;
    /**
     * Check if a batch has a pending upload
     */
    hasPending(batchId: string): boolean;
}
//# sourceMappingURL=debounced-uploader.d.ts.map