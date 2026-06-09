// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'swarm-ui-theme'

function createThemeStore() {
  let theme = $state<Theme>('light')

  function apply(next: Theme) {
    theme = next
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem(STORAGE_KEY, next)
  }

  function init() {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') {
      apply(stored)
      return
    }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    apply(prefersDark ? 'dark' : 'light')
  }

  function toggle() {
    apply(theme === 'dark' ? 'light' : 'dark')
  }

  return {
    get current() {
      return theme
    },
    init,
    toggle,
  }
}

export const themeStore = createThemeStore()
