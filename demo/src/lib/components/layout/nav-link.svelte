<script lang="ts">
  import { page } from '$app/state'
  import { base } from '$app/paths'
  import { cn } from '$lib/utils'
  import { sidebarStore } from '$lib/stores/sidebar.svelte'

  interface Props {
    href: string
    label: string
  }

  let { href, label }: Props = $props()

  const isActive = $derived(
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href),
  )
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- static routes with base path -->
<a
  href="{base}{href}"
  onclick={() => sidebarStore.closeMobile()}
  class={cn(
    'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  )}
>
  {label}
</a>
