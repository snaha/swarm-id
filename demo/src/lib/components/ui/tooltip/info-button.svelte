<script lang="ts">
  import Tooltip from './tooltip.svelte'

  interface Props {
    text: string
  }

  let { text }: Props = $props()
</script>

<Tooltip {text}>
  <span
    class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] leading-none text-muted-foreground cursor-help"
    aria-label="More info"
  >
    i
  </span>
</Tooltip>
