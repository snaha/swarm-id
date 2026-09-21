<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!-- Get Started (frame 573-17153): create an account, or sign in to one
     that exists. The chooser on `/`, the connect popup and `/account/add`
     all show this one. -->
<script lang="ts">
  import { resolve } from '$app/paths'

  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'
</script>

<div class="flex w-full flex-col items-center gap-4">
  <Button size="lg" class="w-full" href={resolve(routes.ACCOUNT_NEW)}>Create a new account</Button>
  <Button size="lg" variant="secondary" class="w-full" href={resolve(routes.ACCOUNT_IMPORT)}>
    I already have an account
  </Button>
</div>
