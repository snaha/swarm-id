<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import { FolderShared } from 'carbon-icons-svelte'
	import routes from '$lib/routes'
	import Hashicon from '$lib/components/hashicon.svelte'
	import BxCheck from '$lib/components/boxicons/bx-check.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { goto } from '$app/navigation'

	let idName = $state('')
</script>

<CreationLayout
	title="Identity"
	description="Create a first identity associated with your Swarm ID account"
	onBack={() => history.back()}
	onClose={() => goto(routes.HOME)}
>
	{#snippet content()}
		<Grid>
			<!-- Row 1 -->
			<Horizontal --horizontal-gap="var(--half-padding)"
				><FolderShared size={20} /><Typography>Account</Typography></Horizontal
			>
			<Input variant="outline" dimension="compact" name="account" />

			<!-- Row 2 -->
			<Typography>ID name</Typography>
			<Horizontal --horizontal-gap="var(--half-padding)">
				<Input variant="outline" dimension="compact" name="id-name" bind:value={idName} />
				{#if idName}
					<Hashicon value={idName} size={40} />
				{/if}
			</Horizontal>
		</Grid>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact">
			<BxCheck />Create and connect</Button
		>
	{/snippet}
</CreationLayout>
