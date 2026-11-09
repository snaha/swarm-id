<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte'

  import { isSignedOutAccount, markFirstPartyStorage } from '@snaha/swarm-id/internal'
  import type { SyncedAccount } from '@snaha/swarm-id/internal'

  import { page } from '$app/state'

  import Toast from '$lib/components/toast.svelte'
  // ponytail: the sync engine lives under `$lib/dev` but operates on real account
  // data; relocating it is not worth the churn here.
  import { foldCurrentAccount, startFoldInterval } from '$lib/dev/account-refresh'
  import { triggerSync } from '$lib/dev/sync-hooks'
  import { inOneTab, watchDriveLifetimes } from '$lib/drive-lifetime-watch'
  import ROUTES from '$lib/routes'
  import { accountBusStore } from '$lib/stores/account-bus'
  import { accountsStore, setAccountsSyncHook } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { themeStore } from '$lib/stores/theme.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'

  import '../app.css'

  let { children } = $props()

  /** The one route that must render framed: the dApp's hidden iframe. */
  const PROXY_ROUTE = '/proxy'
  // Every other page grants something on a click — a connection, a drive, a
  // switch — and nothing sets `frame-ancestors`, so a
  // same-site page could frame one and clickjack it. Refused here, once, so
  // the next grant surface need not remember to; and decided before the page
  // mounts, so a framed page never parses its request or redirects.
  const framed = $derived(page.route.id !== PROXY_ROUTE && window.top !== window)

  /** The stored record for an account, once it is signed in — a signed-out one
   *  carries no `derivationKey`, and the bus topic is derived from it. */
  function signedInRecord(accountIdHex: string | undefined): SyncedAccount | undefined {
    if (!accountIdHex) return undefined
    const record = accountsStore.get(accountIdHex)?.toRecord()
    return record && !isSignedOutAccount(record) ? record : undefined
  }

  onMount(() => {
    themeStore.init()
    // Leave the marker a proxy iframe reads back to learn whether it shares
    // this store — it decides which transport the auth popup can take,
    // and it has to be known before the click. A no-op when framed, which is
    // what keeps the /proxy route (same shell, inside the iframe) from writing
    // it into a partitioned bucket and answering its own question wrong.
    markFirstPartyStorage()
    // Publish account mutations app-wide (debounced): to Swarm for durability,
    // and to the account bus for the live contexts a storage event cannot
    // reach — a partitioned dApp iframe learns about a revoke no other way
    // (docs/Account-Bus.md).
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

  /** A window opened for a dApp's connect or permissions flow, decided by the
   *  page it opened on: it lives for one grant, and its navigations stay in it. */
  const POPUP_ROUTES = [ROUTES.CONNECT, ROUTES.PERMISSIONS]
  const isPopup = POPUP_ROUTES.some((route) => page.route.id?.startsWith(route))

  // The account whose page-load fold has succeeded in this tab. The watcher
  // waits for it: a read that lands before the fold would write a drive this
  // device has not yet learned was removed, and its newer `updatedAt` would
  // beat the tombstone on every device. A failed fold leaves it unset, so the
  // watcher waits for the next load or account switch.
  let foldedAccountId = $state<string | undefined>()

  // A boolean, so the watcher restarts on sign-in or sign-out and not on every
  // write to the account, its own included.
  const currentSignedIn = $derived(signedInRecord(sessionStore.currentAccountId) !== undefined)

  // Re-read the current account's drives from the chain while the site is
  // open, so the expiry warnings follow the chain rather than the last
  // measurement. Only top-level: the same shell renders the dApp's /proxy
  // iframe, which keeps its own readings, and a framed page renders
  // nothing. Not in a connect or permissions popup, where a read and a publish
  // would land mid-grant. One tab per account reads, so N tabs publish a
  // change once.
  $effect(() => {
    const accountId = sessionStore.currentAccountId
    if (!accountId || !currentSignedIn || isPopup || window.top !== window) return
    if (foldedAccountId !== accountId) return
    return untrack(() =>
      inOneTab(`swarm-id-drive-lifetime-${accountId}`, () =>
        watchDriveLifetimes(() =>
          signedInRecord(accountId) ? accountsStore.get(accountId) : undefined,
        ),
      ),
    )
  })

  // Force a fold whenever the active account is set or switched — the page-load
  // ("reload to force") and account-switch triggers. Reads ONLY the id (which
  // applyRefreshed never changes); `untrack` keeps the fold's accountsStore reads
  // out of this effect's dependencies, avoiding an $effect re-fire loop.
  $effect(() => {
    const accountId = sessionStore.currentAccountId
    if (!accountId) {
      return
    }
    untrack(
      () =>
        void foldCurrentAccount(true).then((ok) => {
          if (ok && sessionStore.currentAccountId === accountId) foldedAccountId = accountId
        }),
    )
  })
</script>

{#if framed}
  <p class="text-muted-foreground p-8 text-center text-sm">
    This page cannot be shown inside another site.
  </p>
{:else}
  {@render children()}
{/if}

<Toast message={toastStore.message} />
