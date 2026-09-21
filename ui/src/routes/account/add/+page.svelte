<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!-- Get Started (frame 573-17153): the create/import choice as a page of its
     own, so the account menu's "Sign in to another account" lands somewhere
     instead of rewriting the menu (#727). The chooser on `/` renders the same
     choice inline for a device with no session. -->
<script lang="ts">
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
    <div class="flex w-full max-w-96 flex-col items-center gap-8">
      <SwarmWordmark height={36} />

      <div class="flex w-full flex-col items-center gap-4">
        <Button size="lg" class="w-full" href={resolve(routes.ACCOUNT_NEW)}>
          Create a new account
        </Button>
        <Button size="lg" variant="secondary" class="w-full" href={resolve(routes.ACCOUNT_IMPORT)}>
          I already have an account
        </Button>
      </div>
    </div>
  </main>
</div>
