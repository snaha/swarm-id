<script lang="ts">
  import { onMount } from 'svelte'

  import { themeStore } from '$lib/stores/theme.svelte'

  import '../app.css'

  let { children } = $props()

  onMount(() => {
    themeStore.init()
  })
</script>

{@render children()}
