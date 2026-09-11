// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Swarm hexagon mark — the square part of the logo, without the wordmark.
 *
 * Path data rather than a component, so the mark can also be handed to APIs
 * that want it as plain markup: `swarm-logo.svelte` draws these paths as the
 * head of the full logo, `SWARM_MARK_SVG` is the same mark on its own.
 */
export const SWARM_MARK_PATHS = [
  'M0 17.8927V25.9641L6.97471 30L13.9494 25.9639V17.8913L6.97471 13.8565L0 17.8927Z',
  'M15.9609 17.8923V25.9638L22.9357 29.9999L29.9104 25.9638V17.891L22.9357 13.8564L15.9609 17.8923Z',
  'M21.9251 8.07901L18.4402 6.05435L18.4367 2.01901L14.9552 0L7.98535 4.03614V12.1076L14.9552 16.1435L21.9251 12.1076V8.07901Z',
  'M21.925 8.07901L25.4099 6.053V2.01794L21.9303 0L18.4365 2.01901L21.9303 4.03238L21.925 8.07901Z',
] as const

/**
 * The mark as a standalone SVG string, for icon slots that take markup instead
 * of a URL (web3-onboard's `appMetadata.icon`). Keep it ASCII-only: wallet
 * modules base64 it with `btoa`, which throws on anything else.
 */
export const SWARM_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 30 30" fill="currentColor">${SWARM_MARK_PATHS.map(
  (d) => `<path d="${d}"/>`,
).join('')}</svg>`
