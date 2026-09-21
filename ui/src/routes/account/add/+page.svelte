<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!-- Get Started (frame 573-17153) as a page: where the account menu's
     "Sign in to another account" lands. -->
<script lang="ts">
  import AccountStartChoice from '$lib/components/account-start-choice.svelte'
  import AppHeader from '$lib/components/app-header.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
    <div class="flex w-full max-w-96 flex-col items-center gap-8">
      <SwarmWordmark height={36} />
      <AccountStartChoice />
    </div>
  </main>
</div>
