<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Light from 'carbon-icons-svelte/lib/Light.svelte'
	import Screen from 'carbon-icons-svelte/lib/Screen.svelte'
	import Asleep from 'carbon-icons-svelte/lib/Asleep.svelte'
	import { themeStore } from '$lib/stores/theme.svelte'
</script>

<Horizontal --horizontal-gap="0">
	<Button
		variant={themeStore.preference === 'light' ? 'secondary' : 'ghost'}
		dimension="compact"
		onclick={() => (themeStore.preference = 'light')}
	>
		<Light size={20} />
	</Button>
	<Button
		variant={themeStore.preference === 'auto' ? 'secondary' : 'ghost'}
		dimension="compact"
		onclick={() => (themeStore.preference = 'auto')}
	>
		<Screen size={20} />
	</Button>
	<Button
		variant={themeStore.preference === 'dark' ? 'secondary' : 'ghost'}
		dimension="compact"
		onclick={() => (themeStore.preference = 'dark')}
	>
		<Asleep size={20} />
	</Button>
</Horizontal>
