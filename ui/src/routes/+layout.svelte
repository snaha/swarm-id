<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte'

  import { isSignedOutAccount } from '@snaha/swarm-id'
  import type { SyncedAccount } from '@snaha/swarm-id'

  import Toast from '$lib/components/toast.svelte'
  // ponytail: the sync engine lives under `$lib/dev` but operates on real account
  // data — #389 can relocate it out of `$lib/dev`; not worth the churn here.
  import { foldCurrentAccount, startFoldInterval } from '$lib/dev/account-refresh'
  import { triggerSync } from '$lib/dev/sync-hooks'
  import { accountBusStore } from '$lib/stores/account-bus.svelte'
  import { accountsStore, setAccountsSyncHook } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { themeStore } from '$lib/stores/theme.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'

  import '../app.css'

  let { children } = $props()

  /** The stored record for an account, once it is signed in — a signed-out one
   *  carries no `derivationKey`, and the bus topic is derived from it. */
  function signedInRecord(accountIdHex: string | undefined): SyncedAccount | undefined {
    if (!accountIdHex) return undefined
    const record = accountsStore.get(accountIdHex)?.toRecord()
    return record && !isSignedOutAccount(record) ? record : undefined
  }

  onMount(() => {
    themeStore.init()
    // Publish account mutations app-wide (debounced): to Swarm for durability,
    // and to the account bus for the live contexts a storage event cannot
    // reach — a partitioned dApp iframe learns about a revoke no other way
    // (docs/Account-Bus.md). Previously wired only in /dev, so the shipping app
    // never synced (#389). Owned here now.
    setAccountsSyncHook((accountIdHex) => {
      triggerSync(accountIdHex)
      const record = signedInRecord(accountIdHex)
      if (record) accountBusStore.publish(record)
    })
    // Pull peer/node state back on a periodic (cross-tab-coalesced) tick.
    const stopFolding = startFoldInterval()
    return () => {
      stopFolding()
      accountBusStore.leave()
    }
  })

  // The bus room is the CURRENT account's: join on select/switch, leave on
  // sign-out.
  $effect(() => {
    const record = signedInRecord(sessionStore.currentAccountId)
    if (record) {
      accountBusStore.join(record)
    } else {
      accountBusStore.leave()
    }
  })

  // Force a fold whenever the active account is set or switched — the page-load
  // ("reload to force") and account-switch triggers. Reads ONLY the id (which
  // applyRefreshed never changes); `untrack` keeps the fold's accountsStore reads
  // out of this effect's dependencies, avoiding an $effect re-fire loop.
  $effect(() => {
    if (!sessionStore.currentAccountId) {
      return
    }
    untrack(() => void foldCurrentAccount(true))
  })
</script>

{@render children()}

<Toast message={toastStore.message} />
