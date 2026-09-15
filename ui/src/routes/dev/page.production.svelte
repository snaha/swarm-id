<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  What `+page.svelte` becomes in a production build — see `+page.ts` for why.
  The developer tools are not shipped, so the route answers like any unknown
  one, with the same page `+error.svelte` shows. Nothing dev-only is reachable
  from here, which is what lets Rollup leave the whole dev tree out.
-->

<script lang="ts">
  import ErrorPage from '$lib/components/error-page.svelte'

  const NOT_FOUND = 404
</script>

<ErrorPage status={NOT_FOUND} />
