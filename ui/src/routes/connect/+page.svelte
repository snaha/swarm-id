<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import { Button } from '$lib/components/ui/button'

  let appName = $state('this app')
  let appUrl = $state('')
  let appIcon = $state<string | undefined>(undefined)

  function deriveName(origin: string): string {
    try {
      return new URL(origin).hostname.split('.')[0] || 'this app'
    } catch {
      return 'this app'
    }
  }

  onMount(() => {
    // The connecting dApp passes its details via the URL hash
    // (e.g. #origin=https://coucou.mail&appName=Coucou&appIcon=...).
    const params = new URLSearchParams(window.location.hash.slice(1))
    const origin = params.get('origin') ?? ''
    appUrl = origin
    appName = params.get('appName') ?? deriveName(origin)
    appIcon = params.get('appIcon') ?? (origin ? `${origin}/favicon.ico` : undefined)
  })
</script>

<div class="flex min-h-svh flex-col">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
    <div class="flex w-full max-w-96 flex-col items-center gap-8">
      <div class="flex flex-col items-center gap-2">
        <AppIcon src={appIcon} name={appName} size={48} />
        <div class="flex flex-col items-center text-center">
          <p class="text-lg font-bold">Connect to {appName}</p>
          {#if appUrl}
            <p class="text-sm">{appUrl}</p>
          {/if}
        </div>
      </div>

      <div class="flex w-full flex-col items-center gap-4">
        <Button size="lg" class="w-full" href={resolve('/account/new')}>Create a new account</Button
        >
        <Button size="lg" variant="secondary" class="w-full" href={resolve('/account/import')}>
          I already have an account
        </Button>
      </div>

      <Button variant="ghost" size="xs">What is Swarm ID?</Button>
    </div>
  </main>
</div>
