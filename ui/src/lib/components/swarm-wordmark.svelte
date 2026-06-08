<script lang="ts">
  import SwarmLogo from './swarm-logo.svelte'

  const LOGO_ASPECT = 136 / 30

  let { height = 24 }: { height?: number } = $props()
</script>

<SwarmLogo {height} width={height * LOGO_ASPECT} />
