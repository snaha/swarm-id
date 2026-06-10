// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CURRENT_ACCOUNT_KEY = 'swarm-id-current-account-v2'

/** In-memory state of the account-creation flow; lost on reload by design. */
interface CreationDraft {
  name: string
  phrase?: string
}

function loadCurrentAccountId(): string | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined
  }
  return localStorage.getItem(CURRENT_ACCOUNT_KEY) ?? undefined
}

function createSessionStore() {
  let currentAccountId = $state<string | undefined>(loadCurrentAccountId())
  let draft = $state<CreationDraft | undefined>(undefined)

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
      draft = { name }
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
