<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { jsonRpcCall } from '@snaha/swarm-id'

  import { cn } from '$lib/utils'

  const CHECK_INTERVAL_MS = 10000
  // Shorter than the interval, so a hung endpoint cannot stack up probes.
  const PROBE_TIMEOUT_MS = 5000

  type Status = 'online' | 'offline' | 'checking'
  type CheckMethod = 'head' | 'json-rpc'

  let { endpoint, method = 'head' }: { endpoint: string; method?: CheckMethod } = $props()

  let status = $state<Status>('checking')

  const dotClass: Record<Status, string> = {
    online: 'bg-success',
    offline: 'bg-destructive',
    checking: 'bg-muted-foreground animate-pulse',
  }

  async function probe(url: string, how: CheckMethod): Promise<Status> {
    try {
      if (how === 'json-rpc') {
        // Checked, not a bare fetch: a node answering 200 with a JSON-RPC
        // error is not serving the chain.
        await jsonRpcCall(url, 'eth_blockNumber', [], { timeoutMs: PROBE_TIMEOUT_MS })
        return 'online'
      }
      // Use no-cors HEAD for regular HTTP endpoints
      await fetch(url, { method: 'HEAD', mode: 'no-cors' })
      return 'online'
    } catch {
      return 'offline'
    }
  }

  async function checkEndpoint(url: string, how: CheckMethod) {
    const result = await probe(url, how)
    // The dot sits beside whichever endpoint is configured NOW, so a probe of
    // the one we just left must not colour it.
    if (url !== endpoint) return
    status = result
  }

  // Re-armed whenever the endpoint (or the way to ask it) changes. /dev
  // switches environments in one click, and a dot that only probed on mount
  // showed the previous endpoint's verdict beside the new url for up to the
  // full poll interval — reporting a healthy node dead, or worse.
  $effect(() => {
    const url = endpoint
    const how = method
    status = 'checking'
    void checkEndpoint(url, how)
    const interval = setInterval(() => void checkEndpoint(url, how), CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  })
</script>

<span class={cn('inline-block size-2 shrink-0 rounded-full', dotClass[status])} title={status}
></span>
