// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The connect / disconnect button the proxy paints inside its iframe. The
 * iframe is cross-origin to the embedding page, so `ButtonConfig` is the only
 * styling the page has (#779). This module only draws; the proxy decides when
 * to show the button, in which state, and what a click does.
 */

import type { ButtonConfig } from "../types"

export type AuthButtonState = "loading" | "authenticated" | "unauthenticated"

export interface AuthButtonActions {
  connect: (button: HTMLButtonElement) => void
  disconnect: () => void
}

const SPINNER_STYLE_ID = "swarm-id-spinner-style"

/** Replace `container`'s content with the button for `state`. */
export function renderAuthButton(
  container: HTMLElement,
  state: AuthButtonState,
  config: ButtonConfig | undefined,
  actions: AuthButtonActions,
): void {
  // Clear existing content
  container.innerHTML = ""

  const button = document.createElement("button")
  const isAuthenticated = state === "authenticated"
  const isLoading = state === "loading"

  // Get text from buttonConfig or use defaults
  const options = config || {}
  const loadingText = options.loadingText || "⏳ Loading..."
  const disconnectText = options.disconnectText || "🔓 Disconnect from Swarm ID"
  const connectText = options.connectText || "🔐 Login with Swarm ID"

  if (isLoading) {
    button.textContent = loadingText
    button.disabled = true
  } else if (isAuthenticated) {
    button.textContent = disconnectText
  } else {
    button.textContent = connectText
  }

  // Make button fill container
  button.style.width = "100%"
  button.style.height = "100%"
  button.style.display = "flex"
  button.style.alignItems = "center"
  button.style.justifyContent = "center"

  if (isLoading) {
    button.style.backgroundColor = "#999"
    button.style.cursor = "default"
  } else if (isAuthenticated) {
    // Different color for disconnect button
    button.style.backgroundColor = "#666"
    button.style.cursor = "pointer"
  } else {
    button.style.backgroundColor = options.backgroundColor || "#dd7200"
    button.style.cursor = "pointer"
  }
  button.style.color = options.color || "white"
  button.style.border = "none"
  button.style.borderRadius = options.borderRadius || "0"
  button.style.padding = "0"
  button.style.fontSize = options.fontSize || "14px"
  button.style.fontWeight = options.fontWeight?.toString() ?? "600"
  // No default: left unset the button keeps the font the iframe gives it.
  // Forcing `inherit` here would inherit the IFRAME's font, not the parent
  // page's, so it would change the look without getting any closer to the
  // embedding page. A stack the dApp does pass falls back as usual.
  if (options.fontFamily) {
    button.style.fontFamily = options.fontFamily
  }

  button.addEventListener("click", () => {
    if (isAuthenticated) {
      actions.disconnect()
    } else {
      actions.connect(button)
    }
  })

  container.appendChild(button)
}

/** Disable `button` and replace its label with a spinner. */
export function showButtonSpinner(button: HTMLButtonElement): void {
  button.disabled = true
  button.innerHTML =
    '<span style="display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite;"></span>'

  // Add spinner animation
  if (!document.getElementById(SPINNER_STYLE_ID)) {
    const style = document.createElement("style")
    style.id = SPINNER_STYLE_ID
    style.textContent = "@keyframes spin { to { transform: rotate(360deg); } }"
    document.head.appendChild(style)
  }
}
