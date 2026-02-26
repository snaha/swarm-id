<script lang="ts">
	import Loader from './ui/loader.svelte'
	import Typography from './ui/typography.svelte'
	import Vertical from './ui/vertical.svelte'

	type Props = {
		authenticationType: 'ethereum' | 'passkey' | 'agent'
	}

	let { authenticationType }: Props = $props()

	const title = $derived.by(() => {
		switch (authenticationType) {
			case 'ethereum':
				return 'Confirm with wallet'
			case 'passkey':
				return 'Confirm with passkey'
			case 'agent':
				return 'Agent authentication'
		}
	})

	const description = $derived.by(() => {
		switch (authenticationType) {
			case 'ethereum':
				return 'Please approve the request in your Ethereum wallet'
			case 'passkey':
				return 'Please follow the prompts on your device'
			case 'agent':
				return 'Enter your BIP39 seed phrase to authenticate'
		}
	})
</script>

<Vertical --vertical-align-items="center" --vertical-gap="var(--double-padding)">
	<Vertical --vertical-gap="var(--half-padding)">
		<Typography variant="h4" center>{title}</Typography>
		<Typography center>{description}</Typography>
	</Vertical>
	<Loader />
</Vertical>
