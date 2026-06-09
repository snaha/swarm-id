<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Contrast from '@lucide/svelte/icons/contrast'

  import { Button } from '$lib/components/ui/button'
  import { themeStore } from '$lib/stores/theme.svelte'
</script>

<Button variant="ghost" size="icon" aria-label="Toggle theme" onclick={() => themeStore.toggle()}>
  <Contrast />
</Button>
