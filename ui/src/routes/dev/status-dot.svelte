<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { cn } from '$lib/utils'

  import { type EndpointProbe, beeDev } from './bee'

  const CHECK_INTERVAL_MS = 10_000

  type Status = 'online' | 'offline' | 'checking'

  let { endpoint, probe = 'head' }: { endpoint: string; probe?: EndpointProbe } = $props()

  let status = $state<Status>('checking')

  const COLORS: Record<Status, string> = {
    online: 'bg-success',
    offline: 'bg-destructive',
    checking: 'bg-muted-foreground animate-pulse',
  }

  async function check() {
    status = (await beeDev.checkEndpoint(endpoint, probe)) ? 'online' : 'offline'
  }

  onMount(() => {
    check()
    const interval = setInterval(check, CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  })
</script>

<span class={cn('inline-block size-2 shrink-0 rounded-full', COLORS[status])} title={status}></span>
