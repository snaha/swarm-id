<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  An account's avatar, rendered inline. The generator lives in the lib so dApps
  show the same avatar for an account as this UI does.
-->
<script lang="ts">
  import { generatedAvatarSvg } from '@snaha/swarm-id'

  interface Props {
    value: string
    size?: number
    class?: string
  }

  let { value, size = 40, class: className }: Props = $props()

  const svg = $derived(generatedAvatarSvg(value, size))
</script>

<div class="account-avatar {className ?? ''}" style="width: {size}px; height: {size}px;">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- SVG is generated internally from deterministic hash, not user input -->
  {@html svg}
</div>

<style>
  .account-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
    flex-shrink: 0;
  }
</style>
