/**
 * Generic Versioned Storage Utility
 *
 * Provides a framework-agnostic way to store and retrieve versioned data
 * with automatic migration support.
 */
import { z } from 'zod';
/**
 * Versioned storage wrapper schema
 * Used to check if data is in versioned format
 */
export declare const VersionedStorageSchema: z.ZodObject<{
    version: z.ZodNumber;
    data: z.ZodUnknown;
}, z.core.$strip>;
export type VersionedStorage = z.infer<typeof VersionedStorageSchema>;
/**
 * Storage adapter interface - allows different storage backends
 */
export interface StorageAdapter {
    getItem(key: string): string | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
/**
 * Version parser function - handles migration from one version to another
 */
export type VersionParser<T> = (data: unknown, version: number) => T[];
/**
 * Serializer function - converts data to JSON-serializable format
 */
export type Serializer<T> = (data: T) => Record<string, unknown>;
/**
 * Listener function for storage change events
 */
export type StorageChangeListener<T> = (data: T[]) => void;
/**
 * Options for versioned storage
 */
export interface VersionedStorageOptions<T> {
    /** Storage key */
    key: string;
    /** Current version number */
    currentVersion: number;
    /** Storage adapter (e.g., localStorage) */
    storage: StorageAdapter;
    /** Version parsers - map of version to parser function */
    parsers: Record<number, VersionParser<T>>;
    /** Optional serializer for complex types */
    serializer?: Serializer<T>;
    /** Logger name for error messages */
    loggerName?: string;
}
/**
 * LocalStorage adapter for browser environments
 */
export declare class LocalStorageAdapter implements StorageAdapter {
    getItem(key: string): string | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
/**
 * In-memory storage adapter (for testing or non-browser environments)
 */
export declare class MemoryStorageAdapter implements StorageAdapter {
    private storage;
    getItem(key: string): string | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
}
/**
 * Generic versioned storage manager
 */
export declare class VersionedStorageManager<T> {
    private options;
    private listeners;
    private boundStorageHandler;
    constructor(options: VersionedStorageOptions<T>);
    /**
     * Subscribe to storage change events from other windows/tabs
     * The browser's storage event fires when localStorage changes in OTHER windows,
     * making this useful for cross-window synchronization.
     *
     * @param listener - Callback function that receives the updated data
     * @returns Unsubscribe function to remove the listener
     */
    subscribe(listener: StorageChangeListener<T>): () => void;
    /**
     * Set up the browser storage event listener
     * Only listens for changes to this manager's specific key
     */
    private setupStorageEventListener;
    /**
     * Clean up the storage event listener when no more subscribers
     */
    private cleanupStorageEventListener;
    /**
     * Notify all listeners of data changes
     */
    private notifyListeners;
    /**
     * Load data from storage
     */
    load(): T[];
    /**
     * Parse versioned data and migrate if needed
     */
    private parse;
    /**
     * Save data to storage
     */
    save(data: T[]): void;
    /**
     * Clear data from storage
     */
    clear(): void;
}
/**
 * Create a versioned storage manager with localStorage
 */
export declare function createLocalStorageManager<T>(options: Omit<VersionedStorageOptions<T>, 'storage'>): VersionedStorageManager<T>;
/**
 * Create a versioned storage manager with memory storage
 */
export declare function createMemoryStorageManager<T>(options: Omit<VersionedStorageOptions<T>, 'storage'>): VersionedStorageManager<T>;
/**
 * Create a simple Zod-based parser for a single version
 */
export declare function createZodParser<T>(schema: z.ZodType<T[]>): VersionParser<T>;
//# sourceMappingURL=versioned-storage.d.ts.map