<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts" module>
  /**
   * Appended to the root href so `/` shows the sign-in chooser instead of
   * rendering this page again when the device has no accounts yet.
   */
  export const SIGNIN_SEARCH = '?signin'
</script>

<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import BookText from '@lucide/svelte/icons/book-text'
  import Github from '@lucide/svelte/icons/github'

  import { resolve } from '$app/paths'

  import ProductHeroBg from '$lib/components/product-hero-bg.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'
  import { themeStore } from '$lib/stores/theme.svelte'

  const DOCS_URL = 'https://swarm.snaha.net/docs/'
  const GITHUB_URL = 'https://github.com/snaha/swarm-id'
  const SNAHA_URL = 'https://snaha.net'
  const SWARM_FOUNDATION_URL = 'https://www.ethswarm.org'

  function toggleTheme() {
    themeStore.set(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
  }
</script>

<svelte:head>
  <title>Swarm ID — The Identity Layer on Swarm</title>
</svelte:head>

<div class="bg-background relative flex min-h-svh flex-col items-center gap-48 overflow-x-clip">
  <div
    class="pointer-events-none absolute top-0 left-1/2 w-full max-w-[1366px] -translate-x-1/2"
    aria-hidden="true"
  >
    <ProductHeroBg />
  </div>

  <header class="relative flex w-full max-w-[1366px] items-center gap-2 p-8">
    <SwarmWordmark height={30} />
    <div class="flex flex-1 items-center justify-end gap-2">
      <Button variant="outline" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
        <BookText />
        Documentation
      </Button>
      <Button href={resolve(routes.ROOT) + SIGNIN_SEARCH}>
        Get started
        <ArrowRight />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Toggle theme" onclick={toggleTheme}>
        <!-- Remix Icon contrast-fill, per the Figma design (no lucide equivalent) -->
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path
            d="M8 14.6667C4.318 14.6667 1.33333 11.682 1.33333 8C1.33333 4.318 4.318 1.33333 8 1.33333C11.682 1.33333 14.6667 4.318 14.6667 8C14.6667 11.682 11.682 14.6667 8 14.6667ZM8 13.3333V2.66667C6.58551 2.66667 5.22896 3.22857 4.22876 4.22876C3.22857 5.22896 2.66667 6.58551 2.66667 8C2.66667 9.41449 3.22857 10.771 4.22876 11.7712C5.22896 12.7714 6.58551 13.3333 8 13.3333Z"
            fill="currentColor"
          />
        </svg>
      </Button>
    </div>
  </header>

  <div class="relative flex w-full flex-1 flex-col items-center gap-24">
    <section class="flex w-full max-w-2xl flex-col items-center gap-8 px-8 text-center">
      <div class="flex flex-col gap-4">
        <h1 class="text-4xl leading-10 font-bold">The Identity Layer on Swarm</h1>
        <p class="text-2xl">
          A decentralized identity layer with built-in access control and monetization capabilities
          for web3 apps
        </p>
      </div>
      <div class="flex flex-wrap justify-center gap-4">
        <Button
          variant="outline"
          size="lg"
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <BookText />
          Documentation
        </Button>
        <Button size="lg" href={resolve(routes.ROOT) + SIGNIN_SEARCH}>
          Get started
          <ArrowRight />
        </Button>
      </div>
    </section>

    <section class="flex w-full max-w-7xl flex-wrap justify-center gap-4 px-8">
      <div
        class="bg-card border-foreground/10 shadow-xs flex w-96 max-w-full flex-col gap-2 rounded-xl border p-4"
      >
        <svg
          class="size-8"
          viewBox="0 0 32 32"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M4 4H28C28.3536 4 28.6928 4.14048 28.9428 4.39052C29.1929 4.64057 29.3333 4.97971 29.3333 5.33333V26.6667C29.3333 27.0203 29.1929 27.3594 28.9428 27.6095C28.6928 27.8595 28.3536 28 28 28H4C3.64638 28 3.30724 27.8595 3.05719 27.6095C2.80714 27.3594 2.66667 27.0203 2.66667 26.6667V5.33333C2.66667 4.97971 2.80714 4.64057 3.05719 4.39052C3.30724 4.14048 3.64638 4 4 4ZM21.952 20.7147L26.6667 16L21.952 11.2853L20.0667 13.1733L22.896 16L20.0667 18.828L21.952 20.7147ZM9.104 16L11.9333 13.172L10.048 11.2853L5.33333 16L10.048 20.7147L11.9333 18.8267L9.104 16ZM14.992 22.6667L19.8453 9.33333H17.008L12.1547 22.6667H14.992Z"
            fill="currentColor"
          />
        </svg>
        <h2 class="text-2xl font-bold">Developers</h2>
        <p class="text-xl">Build apps without the infrastructure headaches</p>
        <p class="text-muted-foreground">
          Swarm ID provides an authentication and access control layer that handles the complexity
          of Swarm's infrastructure for you. With secure key management and portable postage
          batches, you can just focus on building great apps.
        </p>
      </div>

      <div
        class="bg-card border-foreground/10 shadow-xs flex w-96 max-w-full flex-col gap-2 rounded-xl border p-4"
      >
        <svg
          class="size-8"
          viewBox="0 0 24 32"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <g fill="currentColor">
            <path
              d="M18 4.8H6C5.33726 4.8 4.8 5.51634 4.8 6.4C4.8 7.28366 5.33726 8 6 8H18C18.6627 8 19.2 7.28366 19.2 6.4C19.2 5.51634 18.6627 4.8 18 4.8Z"
            />
            <path
              d="M18 11.2H6C5.33726 11.2 4.8 11.9163 4.8 12.8C4.8 13.6837 5.33726 14.4 6 14.4H18C18.6627 14.4 19.2 13.6837 19.2 12.8C19.2 11.9163 18.6627 11.2 18 11.2Z"
            />
            <path
              d="M7.2 17.6H6C5.33726 17.6 4.8 18.3163 4.8 19.2C4.8 20.0837 5.33726 20.8 6 20.8H7.2C7.86274 20.8 8.4 20.0837 8.4 19.2C8.4 18.3163 7.86274 17.6 7.2 17.6Z"
            />
            <path
              d="M8.4 24H6C5.33726 24 4.8 24.7163 4.8 25.6C4.8 26.4837 5.33726 27.2 6 27.2H8.4C9.06274 27.2 9.6 26.4837 9.6 25.6C9.6 24.7163 9.06274 24 8.4 24Z"
            />
            <path
              d="M12.6 17.6H11.4C10.7373 17.6 10.2 18.3163 10.2 19.2C10.2 20.0837 10.7373 20.8 11.4 20.8H12.6C13.2627 20.8 13.8 20.0837 13.8 19.2C13.8 18.3163 13.2627 17.6 12.6 17.6Z"
            />
            <path
              d="M20.5848 18.1536C20.3188 17.7992 19.9582 17.6002 19.5822 17.6002C19.2062 17.6002 18.8456 17.7992 18.5796 18.1536L13.2 25.3264V28H15.2052L20.5848 20.8272C20.8506 20.4726 20.9999 19.9917 20.9999 19.4904C20.9999 18.9891 20.8506 18.5082 20.5848 18.1536Z"
            />
          </g>
        </svg>
        <h2 class="text-2xl font-bold">Content Creators</h2>
        <p class="text-xl">Upload content to Swarm and share on your terms</p>
        <p class="text-muted-foreground">
          Swarm ID's built-in authentication layer lets you monetize access to your content while
          maintaining permissionless, censorship-resistant sharing through Swarm. Accept flexible
          on-chain payments and keep full control of your work without intermediaries.
        </p>
      </div>

      <div
        class="bg-card border-foreground/10 shadow-xs flex w-96 max-w-full flex-col gap-2 rounded-xl border p-4"
      >
        <svg
          class="size-8"
          viewBox="0 0 32 32"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M2.66667 29.3333C2.66667 26.5044 3.79047 23.7912 5.79086 21.7909C7.79125 19.7905 10.5044 18.6667 13.3333 18.6667C16.1623 18.6667 18.8754 19.7905 20.8758 21.7909C22.8762 23.7912 24 26.5044 24 29.3333H21.3333C21.3333 27.2116 20.4905 25.1768 18.9902 23.6765C17.4899 22.1762 15.4551 21.3333 13.3333 21.3333C11.2116 21.3333 9.17677 22.1762 7.67648 23.6765C6.17619 25.1768 5.33333 27.2116 5.33333 29.3333H2.66667ZM13.3333 17.3333C8.91333 17.3333 5.33333 13.7533 5.33333 9.33333C5.33333 4.91333 8.91333 1.33333 13.3333 1.33333C17.7533 1.33333 21.3333 4.91333 21.3333 9.33333C21.3333 13.7533 17.7533 17.3333 13.3333 17.3333ZM13.3333 14.6667C16.28 14.6667 18.6667 12.28 18.6667 9.33333C18.6667 6.38667 16.28 4 13.3333 4C10.3867 4 8 6.38667 8 9.33333C8 12.28 10.3867 14.6667 13.3333 14.6667ZM24.3787 19.604C26.2524 20.4479 27.8426 21.815 28.9581 23.5409C30.0736 25.2669 30.6669 27.2783 30.6667 29.3333H28C28.0003 27.792 27.5554 26.2833 26.7188 24.9888C25.8822 23.6942 24.6894 22.6689 23.284 22.036L24.3787 19.604ZM23.4613 4.55067C24.8047 5.1044 25.9533 6.04472 26.7614 7.25231C27.5694 8.4599 28.0005 9.88032 28 11.3333C28.0006 13.1631 27.3169 14.927 26.0834 16.2784C24.8499 17.6299 23.1556 18.4713 21.3333 18.6373V15.9533C22.3213 15.8118 23.2378 15.3574 23.9484 14.6566C24.659 13.9559 25.1263 13.0458 25.2815 12.0599C25.4368 11.0741 25.272 10.0644 24.8112 9.17914C24.3504 8.29388 23.6179 7.57966 22.7213 7.14133L23.4613 4.55067Z"
            fill="currentColor"
          />
        </svg>
        <h2 class="text-2xl font-bold">App users</h2>
        <p class="text-xl">Connect to Web3 apps with advanced privacy controls</p>
        <p class="text-muted-foreground">
          Create unlimited separate accounts for different apps and switch between them easily.
          Secure each account with an Ethereum wallet, passkey, or password for convenient access
          without compromising your private keys.
        </p>
      </div>
    </section>

    <footer class="mt-auto flex w-full max-w-7xl flex-wrap items-center gap-2.5 p-8">
      <Button variant="ghost" size="xs" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
        <Github />
        Github repository
      </Button>
      <Button variant="ghost" size="xs" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
        <BookText />
        Documentation
      </Button>
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external links -->
      <p class="text-muted-foreground flex-1 text-right text-sm">
        Made by
        <a href={SNAHA_URL} target="_blank" rel="noopener noreferrer" class="underline">Snaha</a>
        for the
        <a href={SWARM_FOUNDATION_URL} target="_blank" rel="noopener noreferrer" class="underline">
          Ethereum Swarm Foundation
        </a>
        • 2026
      </p>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    </footer>
  </div>
</div>
