<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  The typed-phrase guard of a destructive dialog (#958, #925): the user types
  `phrase` to confirm; `confirmed` says whether they have, and Enter submits.
  A fixed phrase, as what it guards (a drive name) can be blank or long.
-->
<script lang="ts">
  import { Input } from '$lib/components/ui/input'

  interface Props {
    id: string
    phrase: string
    confirmed: boolean
    onsubmit: () => void
  }

  // eslint-disable-next-line no-useless-assignment -- written for the parent through bind:confirmed, which the core rule cannot see
  let { id, phrase, confirmed = $bindable(), onsubmit }: Props = $props()
</script>

<div class="flex flex-col gap-1">
  <label for={id} class="text-sm">
    Type <code class="bg-muted rounded px-1 py-0.5 font-medium">{phrase}</code> to confirm
  </label>
  <Input
    {id}
    oninput={(event) => {
      confirmed = event.currentTarget.value.trim().toLowerCase() === phrase
    }}
    autocomplete="off"
    spellcheck={false}
    data-autofocus
    onkeydown={(event) => {
      if (event.key === 'Enter') onsubmit()
    }}
  />
</div>
