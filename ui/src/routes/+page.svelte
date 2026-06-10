<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { resolve } from '$app/paths'

  import SettingsMenu from '$lib/components/settings-menu.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
</script>

<div class="relative flex min-h-svh flex-col items-center justify-center p-8">
  <div class="absolute top-8 right-8">
    <SettingsMenu />
  </div>

  <div class="flex w-full max-w-96 flex-col items-center gap-8">
    <SwarmWordmark height={36} />

    <div class="flex w-full flex-col items-center gap-4">
      <Button size="lg" class="w-full" href={resolve('/account/new')}>Create a new account</Button>
      <Button size="lg" variant="secondary" class="w-full" href={resolve('/account/import')}>
        I already have an account
      </Button>
    </div>
  </div>
</div>
