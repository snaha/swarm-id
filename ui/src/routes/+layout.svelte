<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import Toast from '$lib/components/toast.svelte'
  // ponytail: the sync engine lives under `$lib/dev` but operates on real account
  // data — #389 can relocate it out of `$lib/dev`; not worth the churn here.
  import { foldCurrentAccount, startFoldInterval } from '$lib/dev/account-refresh'
  import { triggerSync } from '$lib/dev/sync-hooks'
  import { setAccountsSyncHook } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { themeStore } from '$lib/stores/theme.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'

  import '../app.css'

  let { children } = $props()

  onMount(() => {
    themeStore.init()
    // Publish account mutations to Swarm app-wide (debounced). Previously wired
    // only in /dev, so the shipping app never synced (#389). Owned here now.
    setAccountsSyncHook(triggerSync)
    // Pull peer/node state back on a periodic (cross-tab-coalesced) tick.
    return startFoldInterval()
  })

  // Force a fold whenever the active account is set or switched — the page-load
  // ("reload to force") and account-switch triggers. Reads ONLY the id (which
  // applyRefreshed never changes) and defers the call so the fold's accountsStore
  // reads aren't tracked, avoiding an $effect re-fire loop.
  $effect(() => {
    if (!sessionStore.currentAccountId) {
      return
    }
    const timer = setTimeout(() => void foldCurrentAccount(true), 0)
    return () => clearTimeout(timer)
  })
</script>

{@render children()}

<Toast message={toastStore.message} />
