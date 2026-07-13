// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AppMetadata } from "../types"

/**
 * Normalize a URL by removing trailing slash.
 */
export function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

/**
 * True only for a well-formed `http:`/`https:` URL. Unlike a bare
 * `new URL(value)` / zod `.url()` check, this rejects a scheme-less paste like
 * `localhost:1633` (which `new URL` happily parses with protocol `localhost:`)
 * — the single validator shared by the network-settings schema and its editor
 * dialog so a broken Bee/RPC endpoint can't be saved or persisted.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Configuration options for building the authentication URL.
 */
export interface BuildAuthUrlOptions {
  /**
   * Challenge string for storage partitioning detection. When present, the popup checks
   * if it can read this challenge from localStorage to determine whether
   * storage is partitioned.
   */
  challenge?: string
}

/**
 * Build the authentication URL for connecting to Swarm ID
 *
 * This function creates the same URL format as used by SwarmIdProxy.openAuthPopup()
 * to ensure consistency across the library.
 *
 * @param baseUrl - The base URL where the authentication page is hosted
 * @param origin - The origin of the parent application requesting authentication
 * @param metadata - Optional application metadata to display during authentication
 * @param options - Optional configuration for the auth URL
 * @returns The complete authentication URL with hash parameters
 *
 * @example
 * ```typescript
 * const url = buildAuthUrl(
 *   "https://swarm-id.example.com",
 *   "https://myapp.example.com",
 *   { name: "My App", description: "A decentralized application" }
 * )
 * // Returns: "https://swarm-id.example.com/connect#origin=https%3A%2F%2Fmyapp.example.com&appName=My+App&appDescription=A+decentralized+application"
 * ```
 */
export function buildAuthUrl(
  baseUrl: string,
  origin: string,
  metadata?: AppMetadata,
  options?: BuildAuthUrlOptions,
): string {
  // Build URL with hash parameters (avoids re-renders in SPA)
  const params = new URLSearchParams()
  params.set("origin", origin)

  if (metadata) {
    params.set("appName", metadata.name)
    if (metadata.description) {
      params.set("appDescription", metadata.description)
    }
    if (metadata.icon) {
      params.set("appIcon", metadata.icon)
    }
  }

  if (options?.challenge) {
    params.set("challenge", options.challenge)
  }

  return `${baseUrl}/connect#${params.toString()}`
}
