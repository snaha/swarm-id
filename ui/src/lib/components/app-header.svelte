<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import SettingsMenu from './settings-menu.svelte'
  import SwarmWordmark from './swarm-wordmark.svelte'
</script>

<header class="flex w-full items-center gap-2 p-8">
  <SwarmWordmark height={30} />
  <div class="flex flex-1 items-center justify-end">
    <SettingsMenu />
  </div>
</header>
