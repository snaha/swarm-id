// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Account } from '$lib/types'

const STORAGE_KEY = 'swarm-id-accounts-v2'

function load(): Account[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as Account[]
  } catch {
    return []
  }
}

function createAccountsStore() {
  let accounts = $state<Account[]>(load())

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
  }

  // Keep tabs in sync: another tab writing accounts updates this one.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) {
        accounts = load()
      }
    })
  }

  return {
    get accounts() {
      return accounts
    },
    get(id: string): Account | undefined {
      return accounts.find((account) => account.id === id)
    },
    add(account: Account) {
      accounts = [...accounts, account]
      persist()
    },
  }
}

export const accountsStore = createAccountsStore()
