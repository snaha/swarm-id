<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { page } from '$app/state'

  import ErrorPage from '$lib/components/error-page.svelte'
</script>

<ErrorPage status={page.status} message={page.error?.message} />
