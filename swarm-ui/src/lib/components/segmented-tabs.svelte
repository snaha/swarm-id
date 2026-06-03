<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts" module>
  export type SegmentedTabItem<T extends string> = {
    value: T
    label: string
  }
</script>

<script lang="ts" generics="T extends string">
  interface Props {
    tabs: readonly SegmentedTabItem<T>[]
    active: T
    onchange: (value: T) => void
  }

  let { tabs, active, onchange }: Props = $props()
</script>

<div class="segmented-tabs" role="tablist">
  {#each tabs as tab (tab.value)}
    <button
      type="button"
      role="tab"
      aria-selected={active === tab.value}
      class="tab"
      class:active={active === tab.value}
      onclick={() => onchange(tab.value)}
    >
      {tab.label}
    </button>
  {/each}
</div>

<style>
  .segmented-tabs {
    display: flex;
    width: 100%;
    border: 1px solid var(--colors-low);
  }

  .tab {
    flex: 1;
    padding: var(--three-quarters-padding) var(--padding);
    border: none;
    background-color: transparent;
    color: var(--colors-ultra-high);
    font-family: var(--font-family-sans-serif);
    font-size: var(--font-size);
    line-height: var(--line-height);
    cursor: pointer;
  }

  .tab:not(:last-child) {
    border-right: 1px solid var(--colors-low);
  }

  .tab:hover:not(.active) {
    background-color: var(--colors-ultra-low);
  }

  .tab.active {
    background-color: var(--colors-low);
    color: var(--colors-high);
  }
</style>
