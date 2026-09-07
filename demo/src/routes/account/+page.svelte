<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Card, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card'
  import { clientStore } from '$lib/stores/client.svelte'

  const COPY_RESET_MS = 2000

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
          Your identity on the trusted domain. The address and public key identify the account. The
          sharing key is the one other people grant access to, and it is the same in every app you
          connect.
        </CardDescription>
      </CardHeader>
      <div class="px-6 pb-6 space-y-3 p-6">
        <div class="flex items-center gap-3">
          <img
            src={clientStore.identity.avatar.url}
            alt=""
            class="size-12 shrink-0 rounded-lg"
            data-avatar-source={clientStore.identity.avatar.source}
          />
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

        {#if clientStore.identity.sharingPublicKey}
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Sharing Key
            </div>
            <button
              class="group flex items-center gap-2 w-full text-left"
              onclick={() =>
                copyToClipboard(clientStore.identity!.sharingPublicKey!, 'identity-sharingkey')}
            >
              <code class="text-sm font-mono text-foreground break-all">
                {clientStore.identity.sharingPublicKey}
              </code>
              {#if copiedField === 'identity-sharingkey'}
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
            <p class="text-xs text-muted-foreground mt-1">
              Give this to anyone who wants to share with you. Data granted to it can be read from
              every app connected to this account, not only this origin, so it works across dApps
              and between the dev and production origins of one app. Publish with the checkbox on
              the Access Control page to let any of your apps manage that data's grantees.
            </p>
          </div>
        {/if}
      </div>
    </Card>

    {#if clientStore.appKey}
      <Card>
        <CardHeader>
          <CardTitle>App Key</CardTitle>
          <CardDescription>
            Derived from your identity for this app's origin. A grant to this public key is readable
            in this app only; use the sharing key above to reach the person in every app.
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
