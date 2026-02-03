<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { themeStore } from '$lib/stores/theme.svelte'
	import { Automatic, Light, Asleep } from 'carbon-icons-svelte'
</script>

<Horizontal --horizontal-gap="0" style="border: 1px solid var(--colors-low)">
	<Button
		variant="ghost"
		active={themeStore.preference === 'auto'}
		dimension="compact"
		onclick={() => (themeStore.preference = 'auto')}
	>
		<Automatic size={20} />
	</Button>
	<Button
		variant="ghost"
		active={themeStore.preference === 'light'}
		dimension="compact"
		onclick={() => (themeStore.preference = 'light')}
	>
		<Light size={20} />
	</Button>
	<Button
		variant="ghost"
		active={themeStore.preference === 'dark'}
		dimension="compact"
		onclick={() => (themeStore.preference = 'dark')}
	>
		<Asleep size={20} />
	</Button>
</Horizontal>
