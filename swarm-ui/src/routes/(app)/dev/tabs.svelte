<script lang="ts" module>
  export type TabItem<T extends string> = {
    value: T
    label: string
  }
</script>

<script lang="ts" generics="T extends string">
  import Button from '$lib/components/ui/button.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'

  let {
    tabs,
    active = $bindable(),
  }: {
    tabs: readonly TabItem<T>[]
    active: T
  } = $props()
</script>

<Horizontal --horizontal-gap="var(--half-padding)">
  {#each tabs as tab (tab.value)}
    <Button
      variant={active === tab.value ? 'solid' : 'ghost'}
      dimension="compact"
      onclick={() => (active = tab.value)}
    >
      {tab.label}
    </Button>
  {/each}
</Horizontal>
