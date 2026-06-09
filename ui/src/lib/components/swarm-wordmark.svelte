<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import SwarmLogo from './swarm-logo.svelte'

  const LOGO_ASPECT = 136 / 30

  let { height = 24 }: { height?: number } = $props()
</script>

<SwarmLogo {height} width={height * LOGO_ASPECT} />
