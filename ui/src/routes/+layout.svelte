<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import Toast from '$lib/components/toast.svelte'
  // ponytail: the sync engine lives under `$lib/dev` but operates on real account
  // data — #389 can relocate it out of `$lib/dev`; not worth the churn here.
  import { triggerSync } from '$lib/dev/sync-hooks'
  import { setAccountsSyncHook } from '$lib/stores/accounts.svelte'
  import { themeStore } from '$lib/stores/theme.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'

  import '../app.css'

  let { children } = $props()

  onMount(() => {
    themeStore.init()
    // Publish account mutations to Swarm app-wide (debounced). Previously wired
    // only in /dev, so the shipping app never synced (#389). Owned here now.
    setAccountsSyncHook(triggerSync)
  })
</script>

{@render children()}

<Toast message={toastStore.message} />
