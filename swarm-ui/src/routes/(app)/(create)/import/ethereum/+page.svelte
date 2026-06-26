<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { onMount } from 'svelte'
  import routes from '$lib/routes'

  // Import is now type-agnostic in the unified account model: a single
  // recovery-phrase based import handles every backup. This legacy route just
  // forwards to it.
  onMount(() => {
    goto(resolve(routes.IMPORT_PASSKEY))
  })
</script>
