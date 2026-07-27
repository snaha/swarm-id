<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Polycon — polygon-based identicon. The generator lives in the lib so dApps
  render the same icon for an account as this UI does.
-->
<script lang="ts">
  import { identiconSvg } from '@snaha/swarm-id'

  interface Props {
    value: string
    size?: number
    class?: string
  }

  let { value, size = 40, class: className }: Props = $props()

  const svg = $derived(identiconSvg(value, size))
</script>

<div class="polycon {className ?? ''}" style="width: {size}px; height: {size}px;">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- SVG is generated internally from deterministic hash, not user input -->
  {@html svg}
</div>

<style>
  .polycon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
    flex-shrink: 0;
  }
</style>
