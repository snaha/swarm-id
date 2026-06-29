<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { cn } from '$lib/utils'

  const CHECK_INTERVAL_MS = 10000

  type Status = 'online' | 'offline' | 'checking'
  type CheckMethod = 'head' | 'json-rpc'

  let { endpoint, method = 'head' }: { endpoint: string; method?: CheckMethod } = $props()

  let status = $state<Status>('checking')

  const dotClass: Record<Status, string> = {
    online: 'bg-success',
    offline: 'bg-destructive',
    checking: 'bg-muted-foreground animate-pulse',
  }

  async function checkEndpoint() {
    try {
      if (method === 'json-rpc') {
        // Use eth_blockNumber for JSON-RPC endpoints
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
        })
        status = response.ok ? 'online' : 'offline'
      } else {
        // Use no-cors HEAD for regular HTTP endpoints
        await fetch(endpoint, { method: 'HEAD', mode: 'no-cors' })
        status = 'online'
      }
    } catch {
      status = 'offline'
    }
  }

  onMount(() => {
    checkEndpoint()
    const interval = setInterval(checkEndpoint, CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  })
</script>

<span class={cn('inline-block size-2 shrink-0 rounded-full', dotClass[status])} title={status}
></span>
