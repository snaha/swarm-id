// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** User-selectable appearance preference. "auto" follows the OS setting. */
export type ThemePreference = 'auto' | 'light' | 'dark'

// Not the old 'swarm-ui-theme' key: earlier deployments auto-persisted the
// OS-resolved theme there on every first visit, so its value can't be told
// apart from an explicit user choice. A fresh key starts everyone on 'auto'.
const STORAGE_KEY = 'swarm-id-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function createThemeStore() {
  let preference = $state<ThemePreference>('auto')
  let initialized = false

  function systemPrefersDark(): boolean {
    return window.matchMedia(DARK_QUERY).matches
  }

  /** Resolve the preference to a concrete theme and reflect it on the document. */
  function applyToDocument() {
    const dark = preference === 'dark' || (preference === 'auto' && systemPrefersDark())
    document.documentElement.classList.toggle('dark', dark)
  }

  function init() {
    if (initialized) {
      return
    }
    initialized = true
    const stored = localStorage.getItem(STORAGE_KEY)
    preference = stored === 'dark' || stored === 'light' || stored === 'auto' ? stored : 'auto'
    applyToDocument()

    // While on "auto", track live OS theme changes.
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (preference === 'auto') {
        applyToDocument()
      }
    })
  }

  function set(next: ThemePreference) {
    preference = next
    localStorage.setItem(STORAGE_KEY, next)
    applyToDocument()
  }

  return {
    get preference() {
      return preference
    },
    init,
    set,
  }
}

export const themeStore = createThemeStore()
