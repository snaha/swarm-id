<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import { page } from '$app/state'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'
  import { refreshAccountFromSwarm } from '$lib/utils/refresh-account-from-swarm'

  let { children } = $props()

  const accountId = $derived(page.params.id)
  const currentPath = $derived(page.url.pathname)

  // Pull the latest published account state from Swarm whenever we land on (or
  // switch to) an account — so a device that's already signed in converges on a
  // peer's changes (new app / stamp / device) without opening the Devices view
  // (#338). Keyed on the account id so it fires once per account, not on the
  // store mutations it triggers (refresh applies via `applyRefreshed`, no sync).
  // Best-effort background pull: a no-backup / network failure is ignored here.
  let lastRefreshedId: string | undefined
  $effect(() => {
    const id = accountId
    if (!id || id === lastRefreshedId) return
    lastRefreshedId = id
    void refreshAccountFromSwarm(id)
  })

  const tabs = $derived(
    accountId
      ? [
          { label: 'Apps', href: resolve(routes.ACCOUNT_APPS, { id: accountId }) },
          { label: 'Stamps', href: resolve(routes.ACCOUNT_STAMPS, { id: accountId }) },
          { label: 'Settings', href: resolve(routes.ACCOUNT_SETTINGS, { id: accountId }) },
        ]
      : [],
  )
</script>

<div class="tab-container">
  <ul>
    {#each tabs as tab (tab.href)}
      <li>
        <Button
          variant="ghost"
          dimension="default"
          active={currentPath === tab.href}
          href={tab.href}
        >
          {tab.label}
        </Button>
      </li>
    {/each}
  </ul>
  <div class="tab-content">
    {@render children()}
  </div>
</div>

<style>
  ul {
    display: flex;
    flex-direction: row;
    justify-content: flex-start;
    gap: 0;
    margin-top: 0px;
    margin-bottom: 0px;
    padding-left: unset;
    list-style: none;
    border: 1px solid var(--colors-low);
  }

  li {
    flex: 1;
    margin: 0;
    padding: 0;
  }

  li :global(button),
  li :global(a) {
    border-radius: 0;
    color: var(--colors-ultra-high);
    text-transform: uppercase;
    font-weight: 700;
    padding: var(--half-padding) !important;
    margin: 0 !important;
    width: 100%;
  }

  li :global(.root) {
    margin: 0;
    padding: 0;
  }

  li :global(button.active),
  li :global(a.active),
  li :global(button.ghost.active),
  li :global(a.ghost.active) {
    background: var(--colors-low) !important;
    color: var(--colors-high) !important;
  }

  .tab-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .tab-content {
    display: flex;
    flex-direction: column;
  }
</style>
