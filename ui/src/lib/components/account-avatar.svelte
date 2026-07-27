<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  An account's avatar. The generator lives in the lib so dApps show the same
  avatar for an account as this UI does.

  Rendered as an image rather than inline markup: inside a Button, the base
  `[&_svg:not([class*='size-'])]:size-4` rule would shrink an inline SVG to
  16px whatever size was asked for.
-->
<script lang="ts">
  import { generatedAvatar } from '@snaha/swarm-id'

  interface Props {
    value: string
    size?: number
    class?: string
  }

  let { value, size = 40, class: className }: Props = $props()

  const avatar = $derived(generatedAvatar(value, size))
</script>

<img
  src={avatar.url}
  alt=""
  width={size}
  height={size}
  class="shrink-0 {className ?? ''}"
  style="width: {size}px; height: {size}px;"
/>
