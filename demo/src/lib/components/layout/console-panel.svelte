<script lang="ts">
  import { logStore } from '$lib/stores/log.svelte'

  let open = $state(false)
  let scrollContainer = $state<HTMLDivElement | undefined>(undefined)

  $effect(() => {
    if (logStore.entries.length && scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight
    }
  })
</script>

<div class="border-t border-border bg-muted">
  <div class="flex w-full items-center justify-between px-4 py-2 text-sm text-muted-foreground">
    <button onclick={() => (open = !open)} class="font-medium hover:text-foreground">
      Console ({logStore.entries.length})
      <span class="text-xs ml-1">{open ? '\u25BC' : '\u25B2'}</span>
    </button>
    <button
      class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onclick={() => logStore.clear()}
    >
      Clear
    </button>
  </div>

  {#if open}
    <div class="h-[200px] overflow-auto bg-card px-4 pb-4" bind:this={scrollContainer}>
      {#each logStore.entries as entry, i (i)}
        <div class="mb-1 font-mono text-xs">
          <span class="text-muted-foreground">[{entry.time}]</span>
          <span
            class={entry.type === 'info'
              ? 'text-success'
              : entry.type === 'error'
                ? 'text-destructive'
                : 'text-warning'}
            class:font-bold={true}
          >
            [{entry.type.toUpperCase()}]
          </span>
          <span class="text-foreground">{entry.message}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
