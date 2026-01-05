/**
 * Generic Versioned Storage Utility
 *
 * Provides a framework-agnostic way to store and retrieve versioned data
 * with automatic migration support.
 */

import { z } from "zod"

// ============================================================================
// Types & Schemas
// ============================================================================

/**
 * Versioned storage wrapper schema
 * Used to check if data is in versioned format
 */
export const VersionedStorageSchema = z.object({
  version: z.number().int().nonnegative(),
  data: z.unknown(),
})

export type VersionedStorage = z.infer<typeof VersionedStorageSchema>

/**
 * Storage adapter interface - allows different storage backends
 */
export interface StorageAdapter {
  getItem(key: string): string | undefined
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Version parser function - handles migration from one version to another
 */
export type VersionParser<T> = (data: unknown, version: number) => T[]

/**
 * Serializer function - converts data to JSON-serializable format
 */
export type Serializer<T> = (data: T) => Record<string, unknown>

/**
 * Options for versioned storage
 */
export interface VersionedStorageOptions<T> {
  /** Storage key */
  key: string

  /** Current version number */
  currentVersion: number

  /** Storage adapter (e.g., localStorage) */
  storage: StorageAdapter

  /** Version parsers - map of version to parser function */
  parsers: Record<number, VersionParser<T>>

  /** Optional serializer for complex types */
  serializer?: Serializer<T>

  /** Logger name for error messages */
  loggerName?: string
}

// ============================================================================
// Browser Storage Adapters
// ============================================================================

/**
 * LocalStorage adapter for browser environments
 */
export class LocalStorageAdapter implements StorageAdapter {
  getItem(key: string): string | undefined {
    if (typeof window === "undefined" || !window.localStorage) {
      return undefined
    }
    return window.localStorage.getItem(key) ?? undefined
  }

  setItem(key: string, value: string): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return
    }
    window.localStorage.setItem(key, value)
  }

  removeItem(key: string): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return
    }
    window.localStorage.removeItem(key)
  }
}

/**
 * In-memory storage adapter (for testing or non-browser environments)
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private storage = new Map<string, string>()

  getItem(key: string): string | undefined {
    return this.storage.get(key)
  }

  setItem(key: string, value: string): void {
    this.storage.set(key, value)
  }

  removeItem(key: string): void {
    this.storage.delete(key)
  }

  clear(): void {
    this.storage.clear()
  }
}

// ============================================================================
// Core Versioned Storage Class
// ============================================================================

/**
 * Generic versioned storage manager
 */
export class VersionedStorageManager<T> {
  private options: VersionedStorageOptions<T>

  constructor(options: VersionedStorageOptions<T>) {
    this.options = options
  }

  /**
   * Load data from storage
   */
  load(): T[] {
    const stored = this.options.storage.getItem(this.options.key)

    if (!stored) {
      return []
    }

    try {
      const parsed: unknown = JSON.parse(stored)
      return this.parse(parsed)
    } catch (e) {
      console.error(`[${this.options.loggerName ?? "Storage"}] Load failed:`, e)
      return []
    }
  }

  /**
   * Parse versioned data and migrate if needed
   */
  private parse(parsed: unknown): T[] {
    // Try to parse as versioned data
    const versioned = VersionedStorageSchema.safeParse(parsed)
    const version = versioned.success ? versioned.data.version : 0
    const data = versioned.success ? versioned.data.data : parsed

    // Find appropriate parser
    const parser = this.options.parsers[version]

    if (!parser) {
      console.error(
        `[${this.options.loggerName ?? "Storage"}] No parser for version ${version}`,
      )
      return []
    }

    return parser(data, version)
  }

  /**
   * Save data to storage
   */
  save(data: T[]): void {
    try {
      // Apply serializer if provided
      const serialized = this.options.serializer
        ? data.map(this.options.serializer)
        : data

      const wrapped: VersionedStorage = {
        version: this.options.currentVersion,
        data: serialized,
      }

      this.options.storage.setItem(this.options.key, JSON.stringify(wrapped))
    } catch (e) {
      console.error(`[${this.options.loggerName ?? "Storage"}] Save failed:`, e)
    }
  }

  /**
   * Clear data from storage
   */
  clear(): void {
    this.options.storage.removeItem(this.options.key)
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a versioned storage manager with localStorage
 */
export function createLocalStorageManager<T>(
  options: Omit<VersionedStorageOptions<T>, "storage">,
): VersionedStorageManager<T> {
  return new VersionedStorageManager({
    ...options,
    storage: new LocalStorageAdapter(),
  })
}

/**
 * Create a versioned storage manager with memory storage
 */
export function createMemoryStorageManager<T>(
  options: Omit<VersionedStorageOptions<T>, "storage">,
): VersionedStorageManager<T> {
  return new VersionedStorageManager({
    ...options,
    storage: new MemoryStorageAdapter(),
  })
}

/**
 * Create a simple Zod-based parser for a single version
 */
export function createZodParser<T>(schema: z.ZodType<T[]>): VersionParser<T> {
  return (data: unknown) => {
    const result = schema.safeParse(data)

    if (!result.success) {
      console.error("Parse failed:", result.error.format())
      return []
    }

    return result.data
  }
}
