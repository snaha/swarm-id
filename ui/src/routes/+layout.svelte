<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { themeStore } from '$lib/stores/theme.svelte'

  import '../app.css'

  let { children } = $props()

  onMount(() => {
    themeStore.init()
  })
</script>

{@render children()}
