<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { identiconSvg } from '@snaha/swarm-id'

  import { Card, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card'
  import { clientStore } from '$lib/stores/client.svelte'

  const COPY_RESET_MS = 2000
  const ICON_SIZE = 48

  let copiedField = $state<string | undefined>(undefined)

  async function copyToClipboard(value: string, field: string) {
    await navigator.clipboard.writeText(value)
    copiedField = field
    setTimeout(() => (copiedField = undefined), COPY_RESET_MS)
  }
</script>

<div class="space-y-6">
  <div class="text-foreground">
    <h1 class="text-2xl font-bold mb-1">Account</h1>
    <p class="text-muted-foreground text-sm">
      Identity and app-specific key details for the current session.
    </p>
  </div>

  {#if clientStore.authenticated && clientStore.identity}
    <Card>
      <CardHeader>
        <CardTitle>Identity</CardTitle>
        <CardDescription>
          Your identity on the trusted domain. The public key is derived from your master key and is
          the same across all apps.
        </CardDescription>
      </CardHeader>
      <div class="px-6 pb-6 space-y-3 p-6">
        <div class="flex items-center gap-3">
          <div class="shrink-0 overflow-hidden rounded-lg leading-none">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- deterministic SVG from the lib, not user input -->
            {@html identiconSvg(clientStore.identity.id, ICON_SIZE)}
          </div>
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Name
            </div>
            <div class="text-sm text-foreground">{clientStore.identity.name}</div>
          </div>
        </div>

        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Address
          </div>
          <button
            class="group flex items-center gap-2 w-full text-left"
            onclick={() => copyToClipboard(clientStore.identity!.address, 'identity-address')}
          >
            <code class="text-sm font-mono text-foreground break-all">
              {clientStore.identity.address}
            </code>
            {#if copiedField === 'identity-address'}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-green-500 shrink-0"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            {:else}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
            {/if}
          </button>
        </div>

        {#if clientStore.identity.publicKey}
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Public Key
            </div>
            <button
              class="group flex items-center gap-2 w-full text-left"
              onclick={() =>
                copyToClipboard(clientStore.identity!.publicKey!, 'identity-publickey')}
            >
              <code class="text-sm font-mono text-foreground break-all">
                {clientStore.identity.publicKey}
              </code>
              {#if copiedField === 'identity-publickey'}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-green-500 shrink-0"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              {:else}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              {/if}
            </button>
          </div>
        {/if}
      </div>
    </Card>

    {#if clientStore.appKey}
      <Card>
        <CardHeader>
          <CardTitle>App Key</CardTitle>
          <CardDescription>
            Derived from your identity for this app's origin. Share the public key below when adding
            grantees for Access Control (ACT) operations.
          </CardDescription>
        </CardHeader>
        <div class="px-6 pb-6 space-y-3 p-6">
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Address
            </div>
            <button
              class="group flex items-center gap-2 w-full text-left"
              onclick={() => copyToClipboard(clientStore.appKey!.address, 'appkey-address')}
            >
              <code class="text-sm font-mono text-foreground break-all">
                {clientStore.appKey.address}
              </code>
              {#if copiedField === 'appkey-address'}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-green-500 shrink-0"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              {:else}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              {/if}
            </button>
          </div>

          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Public Key
            </div>
            <button
              class="group flex items-center gap-2 w-full text-left"
              onclick={() => copyToClipboard(clientStore.appKey!.publicKey, 'appkey-publickey')}
            >
              <code class="text-sm font-mono text-foreground break-all">
                {clientStore.appKey.publicKey}
              </code>
              {#if copiedField === 'appkey-publickey'}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-green-500 shrink-0"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              {:else}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              {/if}
            </button>
          </div>
        </div>
      </Card>
    {/if}
  {:else}
    <Card>
      <CardHeader>
        <CardTitle>Not connected</CardTitle>
        <CardDescription>
          Connect an identity using the sidebar to view account details.
        </CardDescription>
      </CardHeader>
    </Card>
  {/if}
</div>
