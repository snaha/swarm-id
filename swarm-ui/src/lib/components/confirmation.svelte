<script lang="ts">
	import Loader from './ui/loader.svelte'
	import Typography from './ui/typography.svelte'
	import Vertical from './ui/vertical.svelte'

	type Props = {
		authenticationType: 'ethereum' | 'passkey'
	}

	let { authenticationType }: Props = $props()
</script>

<Vertical --vertical-align-items="center" --vertical-gap="var(--double-padding)">
	<Vertical --vertical-gap="var(--half-padding)">
		<Typography variant="h4" center
			>Confirm with {authenticationType === 'ethereum' ? 'wallet' : 'passkey'}</Typography
		>
		<Typography center
			>{#if authenticationType === 'ethereum'}
				Please approve the request in your Ethereum wallet
			{:else}
				Please follow the prompts on your device
			{/if}
		</Typography>
	</Vertical>
	<Loader />
</Vertical>
