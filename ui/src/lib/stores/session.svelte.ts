// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { EthAddress } from '@ethersphere/bee-js'
import type { AccountData } from '@snaha/swarm-id'

const CURRENT_ACCOUNT_KEY = 'swarm-id-current-account-v2'

/** In-memory state of an account setup flow; lost on reload by design. */
interface SetupDraft {
  flow: 'create' | 'sign-in' | 'restore'
  name: string
  /** True once the user edited the name away from the derived default, so a
   * later phrase change must not overwrite their choice. */
  nameCustomized?: boolean
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
  let completedFlow = $state<SetupDraft['flow'] | undefined>(undefined)

  return {
    get currentAccountId() {
      return currentAccountId
    },
    setCurrentAccount(id: EthAddress) {
      const hex = id.toHex()
      currentAccountId = hex
      localStorage.setItem(CURRENT_ACCOUNT_KEY, hex)
    },
    clearCurrentAccount() {
      currentAccountId = undefined
      localStorage.removeItem(CURRENT_ACCOUNT_KEY)
    },
    get draft() {
      return draft
    },
    startDraft(name: string, phrase?: string, nameCustomized?: boolean) {
      // Keep an in-progress create draft (and its generated phrase) so going
      // back to rename does not silently swap in a new recovery phrase.
      draft =
        draft?.flow === 'create'
          ? { ...draft, name, phrase: phrase ?? draft.phrase, nameCustomized }
          : { flow: 'create', name, phrase, nameCustomized }
    },
    setDraftName(name: string) {
      if (draft) {
        draft = { ...draft, name }
      }
    },
    startSignIn(name: string, phrase: string, restored?: AccountData) {
      draft = { flow: 'sign-in', name, phrase, restored }
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
    /** Which setup flow just finished; drives the post-setup confirmation screen. */
    get completedFlow() {
      return completedFlow
    },
    setCompletedFlow(flow: SetupDraft['flow']) {
      completedFlow = flow
    },
  }
}

export const sessionStore = createSessionStore()
