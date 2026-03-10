<script lang="ts">
  import '../app.pcss'
  import { themeStore } from '$lib/stores/theme.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  let { children } = $props()

  void themeStore.preference
  void sessionStore.data
</script>

{@render children()}
