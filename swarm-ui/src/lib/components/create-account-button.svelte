<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Add from 'carbon-icons-svelte/lib/Add.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'

  interface Props {
    /** Whether to show the Add icon. Default: true */
    showIcon?: boolean
  }

  let { showIcon = true }: Props = $props()
</script>

<Button
  variant="ghost"
  dimension="compact"
  leftAlign
  onclick={() => goto(resolve(routes.ACCOUNT_NEW))}
>
  {#if showIcon}<Add size={20} />{/if}Create new account
</Button>
