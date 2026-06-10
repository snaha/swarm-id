// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { AccountData } from '$lib/types'

const CURRENT_ACCOUNT_KEY = 'swarm-id-current-account-v2'

/** In-memory state of an account setup flow; lost on reload by design. */
interface SetupDraft {
  flow: 'create' | 'sign-in' | 'restore'
  name: string
  phrase?: string
  /** Account data carried over by a restore (stamps, apps, original name). */
  restored?: AccountData
}

function loadCurrentAccountId(): string | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined
  }
  return localStorage.getItem(CURRENT_ACCOUNT_KEY) ?? undefined
}

function createSessionStore() {
  let currentAccountId = $state<string | undefined>(loadCurrentAccountId())
  let draft = $state<SetupDraft | undefined>(undefined)

  return {
    get currentAccountId() {
      return currentAccountId
    },
    setCurrentAccount(id: string) {
      currentAccountId = id
      localStorage.setItem(CURRENT_ACCOUNT_KEY, id)
    },
    get draft() {
      return draft
    },
    startDraft(name: string) {
      draft = { flow: 'create', name }
    },
    startSignIn(name: string, phrase: string) {
      draft = { flow: 'sign-in', name, phrase }
    },
    startRestore(restored: AccountData, phrase: string) {
      draft = { flow: 'restore', name: restored.name, phrase, restored }
    },
    setDraftPhrase(phrase: string) {
      if (draft) {
        draft = { ...draft, phrase }
      }
    },
    clearDraft() {
      draft = undefined
    },
  }
}

export const sessionStore = createSessionStore()
