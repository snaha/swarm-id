import type { AppMetadata } from "../types"

/**
 * Build the authentication URL for connecting to Swarm ID
 *
 * This function creates the same URL format as used by SwarmIdProxy.openAuthPopup()
 * to ensure consistency across the library.
 *
 * @param baseUrl - The base URL where the authentication page is hosted
 * @param origin - The origin of the parent application requesting authentication
 * @param metadata - Optional application metadata to display during authentication
 * @param proxyMode - When true, enables proxy mode which validates same-origin opener
 *                    and sends setSecret via postMessage (used for local development)
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
  proxyMode?: boolean,
): string {
  // Build URL with hash parameters (avoids re-renders in SPA)
  const params = new URLSearchParams()
  params.set("origin", origin)

  if (proxyMode) {
    params.set("proxyMode", "true")
  }

  if (metadata) {
    params.set("appName", metadata.name)
    if (metadata.description) {
      params.set("appDescription", metadata.description)
    }
    if (metadata.icon) {
      params.set("appIcon", metadata.icon)
    }
  }

  return `${baseUrl}/connect#${params.toString()}`
}
