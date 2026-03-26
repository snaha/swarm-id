<!--
  Copyright 2024 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Button from '../button.svelte'
  import { type Props } from '../button.svelte'

  let {
    children,
    onclick,
    dimension = 'compact',
    variant = 'ghost',
    ...restProps
  }: Props = $props()

  function onClick(e: MouseEvent) {
    e.preventDefault()
    if (onclick) {
      onclick(
        e as MouseEvent & { currentTarget: EventTarget & HTMLAnchorElement } & {
          currentTarget: EventTarget & HTMLButtonElement
        },
      )
    }
  }
</script>

<Button leftAlign {dimension} {variant} onclick={onClick} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</Button>
