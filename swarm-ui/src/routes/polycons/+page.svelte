<script lang="ts">
  import Polycon from '$lib/components/polycon.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'

  const SIZES = [80, 40, 32]
  const COUNT = 96

  // Generate deterministic Ethereum-like addresses from an index
  function generateSeed(index: number): string {
    let hash = 0x9e3779b9
    for (let i = 0; i < 8; i++) {
      hash ^= (index + i) * 0x517cc1b7
      hash = Math.imul(hash, 0x85ebca6b)
      hash ^= hash >>> 13
    }
    const hex = Array.from({ length: 40 }, (_, i) => {
      hash = Math.imul(hash ^ (i * 0x27d4eb2d), 0xcc9e2d51)
      hash ^= hash >>> 16
      return (Math.abs(hash) % 16).toString(16)
    }).join('')
    return `0x${hex}`
  }

  const seeds = Array.from({ length: COUNT }, (_, i) => generateSeed(i))
</script>

<Vertical --vertical-gap="var(--double-padding)" style="padding: var(--double-padding);">
  <Vertical --vertical-gap="var(--half-padding)">
    <Typography variant="h2">Polycon Gallery</Typography>
    <Typography>
      Deterministic identity icons based on <a
        href="https://github.com/Montoya/polycon"
        target="_blank"
        rel="noopener noreferrer">Polycon</a
      > with Swarm brand colors.
    </Typography>
  </Vertical>

  {#each SIZES as size (size)}
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography variant="large">{size}px</Typography>
      <div class="grid">
        {#each seeds as seed (seed + size)}
          <div class="cell">
            <Polycon value={seed} {size} />
            <Typography variant="small" class="seed">{seed.slice(0, 10)}...</Typography>
          </div>
        {/each}
      </div>
    </Vertical>
  {/each}
</Vertical>

<style>
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--padding);
  }

  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--quarter-padding);
  }

  :global(.seed) {
    font-family: monospace;
    opacity: 0.6;
  }
</style>
