<script lang="ts">
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import BxRightArrowAlt from '$lib/components/boxicons/bx-right-arrow-alt.svelte'
	import { FolderShared } from 'carbon-icons-svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { goto } from '$app/navigation'

	async function handlePasskeyConnect() {
		try {
			console.log('🔐 Authenticating with passkey...')
			const identity = await authenticateWithPasskey({
				rpId: window.location.hostname,
			})

			console.log('✅ Passkey authenticated successfully')
			console.log('Credential ID:', identity.credentialId)
			console.log('PRF Available:', identity.prfAvailable)
			if (identity.prfOutput) {
				console.log(
					'PRF Output (hex):',
					Array.from(identity.prfOutput.slice(0, 8))
						.map((b) => b.toString(16).padStart(2, '0'))
						.join('') + '...',
				)
			}
			console.log('Ethereum Address:', identity.ethereumAddress)
		} catch (error) {
			console.error('❌ Passkey authentication failed:', error)
			if (error instanceof Error) {
				console.error('Error message:', error.message)
			}
		}
	}
</script>

<CreationLayout
	title="Create account"
	description="Create a new Swarm ID account"
	onClose={() => goto(routes.HOME)}
>
	{#snippet content()}
		<Grid>
			<!-- Row 1 -->
			<Horizontal --horizontal-gap="var(--half-padding)"
				><FolderShared size={20} /><Typography>Account name</Typography></Horizontal
			>
			<Input variant="outline" dimension="compact" name="account-name" />

			<!-- Row 2 -->
			<Typography>Authentication</Typography>
			<Horizontal --horizontal-gap="var(--half-padding)"
				><PasskeyLogo size={20} /><Typography>Passkey</Typography></Horizontal
			>
		</Grid>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={() => goto(routes.IDENTITY_NEW)}
			>Confirm and proceed <BxRightArrowAlt /></Button
		>
	{/snippet}
</CreationLayout>
