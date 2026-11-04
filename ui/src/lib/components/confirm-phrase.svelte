<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  The typed-phrase guard of a destructive dialog (#958, #925): the user types
  `phrase` before the confirm button (its content is `children`) does
  anything. A fixed phrase, as what it guards (a drive name) can be blank or
  long.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'

  interface Props {
    id: string
    phrase: string
    onconfirm: () => void
    oncancel: () => void
    children: Snippet
  }

  let { id, phrase, onconfirm, oncancel, children }: Props = $props()

  let typed = $state('')
  const confirmed = $derived(typed.trim().toLowerCase() === phrase)

  function confirm() {
    if (confirmed) onconfirm()
  }
</script>

<div class="flex flex-col gap-1">
  <label for={id} class="text-sm">
    Type <code class="bg-muted rounded px-1 py-0.5 font-medium">{phrase}</code> to confirm
  </label>
  <Input
    {id}
    bind:value={typed}
    autocomplete="off"
    spellcheck={false}
    data-autofocus
    onkeydown={(event) => {
      if (event.key === 'Enter') confirm()
    }}
  />
</div>
<div class="flex w-full flex-col gap-2">
  <Button variant="destructive" class="w-full" disabled={!confirmed} onclick={confirm}>
    {@render children()}
  </Button>
  <Button variant="outline" class="w-full" onclick={oncancel}>Cancel</Button>
</div>
