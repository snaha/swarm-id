<script lang="ts">
  import { onMount } from 'svelte'
  import AppLogo from '$lib/components/app-logo.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import { layoutStore } from '$lib/stores/layout.svelte'

  interface Props {
    appName: string
    appUrl: string
    appIcon?: string
    appDescription?: string
  }

  let { appName, appUrl, appIcon }: Props = $props()

  let faviconUrl = $state<string | undefined>(undefined)
  let isLoading = $state(true)

  onMount(() => {
    detectFavicon()
  })

  async function detectFavicon() {
    try {
      const url = new URL(appUrl)
      const origin = url.origin
      const domain = url.hostname

      // Try different favicon sources in order of preference
      const faviconCandidates = [
        // Modern formats first (SVG is scalable, PNG is common)
        `${origin}/favicon.svg`,
        `${origin}/favicon.png`,
        `${origin}/apple-touch-icon.png`,
        `${origin}/favicon.ico`,
        // Google's favicon service as final fallback (works cross-origin)
        `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      ]

      // Try each candidate until one loads successfully
      for (const candidate of faviconCandidates) {
        const success = await tryLoadImage(candidate)
        if (success) {
          faviconUrl = candidate
          isLoading = false
          return
        }
      }

      // If all fail, show default logo
      faviconUrl = undefined
      isLoading = false
    } catch {
      // If URL parsing fails, show default logo
      faviconUrl = undefined
      isLoading = false
    }
  }

  function tryLoadImage(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      // Set timeout to avoid waiting too long
      setTimeout(() => resolve(false), 3000)
      img.src = url
    })
  }
</script>

{#snippet appIconSnippet()}
  {#if appIcon}
    <img src={appIcon} alt="icon" class="favicon" />
  {:else if !isLoading && faviconUrl}
    <img src={faviconUrl} alt="{appName} favicon" class="favicon" />
  {:else}
    <AppLogo width={56} height={56} />
  {/if}
{/snippet}

{#if layoutStore.mobile}
  <Vertical --vertical-align-items="center" --vertical-gap="var(--half-padding)" class="header">
    {@render appIconSnippet()}
    <Vertical --vertical-gap="0" --vertical-align-items="center">
      <Typography variant="h4">Connect to {appName}</Typography>
      <Typography>{appUrl}</Typography>
    </Vertical>
  </Vertical>
{:else}
  <Horizontal --horizontal-align-items="center" --horizontal-gap="16px" class="header">
    {@render appIconSnippet()}
    <Vertical --vertical-gap="0">
      <Typography variant="h4">Connect to {appName}</Typography>
      <Typography>{appUrl}</Typography>
    </Vertical>
  </Horizontal>
{/if}

<style>
  :global(.header) {
    margin-bottom: var(--double-padding);
  }

  .favicon {
    width: 56px;
    height: 56px;
    object-fit: contain;
  }
</style>
