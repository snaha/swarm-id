<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements'
  type Dimension = 'default' | 'large' | 'compact' | 'small'
  type Color = 'high' | 'low'
  type Props = {
    dimension?: Dimension
    color?: Color
  }
  let { dimension = 'default', color = 'low' }: Props & HTMLAttributes<HTMLDivElement> = $props()
</script>

<div class="loader {dimension}" class:high={color === 'high'} class:low={color === 'low'}></div>

<style lang="postcss">
  .loader {
    padding: 2px;
    aspect-ratio: 1;
    border-radius: 50%;
    mask:
      conic-gradient(#0000 10%, #000),
      linear-gradient(#000 0 0) content-box;
    -webkit-mask-composite: source-out;
    mask-composite: subtract;
    animation: l3 1s infinite linear;
  }

  @keyframes l3 {
    to {
      transform: rotate(1turn);
    }
  }

  /* Dimension sizes */
  .large {
    width: 32px;
  }
  .default,
  .compact {
    width: 24px;
  }
  .small {
    width: 16px;
  }

  /* Colors */
  .high {
    background: var(--colors-base);
  }
  .low {
    background: var(--colors-ultra-high);
  }
</style>
