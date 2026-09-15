<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  The one error page: what `+error.svelte` renders for any status, and what a
  shipped build puts at `/dev` in place of the developer tools. Keep it free of
  anything dev-only — that stub is what keeps the dev tree out of the bundle.
-->

<script lang="ts">
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'

  interface Props {
    status: number
    message?: string
  }

  let { status, message }: Props = $props()

  const NOT_FOUND = 404
  const notFound = $derived(status === NOT_FOUND)
</script>

<div class="flex min-h-svh flex-col">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-center gap-8 text-center">
      <div class="flex flex-col items-center gap-2">
        <p class="text-muted-foreground text-sm">{status}</p>
        <h1 class="text-lg leading-none font-bold">
          {notFound ? 'Page not found' : 'Something went wrong'}
        </h1>
        <p class="text-sm">
          {notFound ? 'There is nothing at this address.' : (message ?? 'Please try again.')}
        </p>
      </div>

      <Button class="w-full" href={resolve(routes.ROOT)}>Go home</Button>
    </div>
  </main>
</div>
