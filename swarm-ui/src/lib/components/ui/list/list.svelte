<!--
  Copyright 2024 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children, ...rest }: { children: Snippet } = $props()
</script>

<ul class="list" {...rest}>
  {@render children()}
</ul>

<style>
  .list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: var(--padding);
    gap: var(--half-padding);
    margin: 0;
    border: 1px solid var(--colors-low);
    background-color: var(--colors-base);
  }
</style>
