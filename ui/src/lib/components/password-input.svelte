<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!-- A password field with a show / hide toggle beside it. -->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'

  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'

  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'

  type Props = Omit<HTMLInputAttributes, 'type' | 'value'> & { value: string }

  let { value = $bindable(), ...rest }: Props = $props()

  let shown = $state(false)
</script>

<div class="flex w-full items-center gap-2">
  <Input type={shown ? 'text' : 'password'} bind:value {...rest} />
  <Button
    variant="ghost"
    size="icon"
    class="size-6 shrink-0 rounded-md [&_svg]:size-3.5"
    aria-label={shown ? 'Hide password' : 'Show password'}
    onclick={() => (shown = !shown)}
  >
    {#if shown}
      <EyeOff />
    {:else}
      <Eye />
    {/if}
  </Button>
</div>
