import type { AppMetadata } from "../types"

/**
 * Configuration options for building the authentication URL.
 */
export interface BuildAuthUrlOptions {
  /**
   * When true, shows the agent sign-up option on the connect page.
   * Agents are automated services that can perform operations on behalf of users.
   */
  agent?: boolean
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

  if (options?.agent) {
    params.set("agent", "")
  }

  return `${baseUrl}/connect#${params.toString()}`
}
