<script lang="ts">
	import Modal from '$lib/components/ui/modal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import CopyButton from '$lib/components/copy-button.svelte'
	import Renew from 'carbon-icons-svelte/lib/Renew.svelte'
	import { generateSecretSeed } from '$lib/utils/secret-seed'
	import { CloseLarge } from 'carbon-icons-svelte'

	interface Props {
		open?: boolean
		onUseSeed?: (seed: string) => void
	}

	let { open = $bindable(false), onUseSeed }: Props = $props()

	let generatedSeed = $state('')

	function handleOpen() {
		generatedSeed = generateSecretSeed()
	}

	function handleUseSeed() {
		onUseSeed?.(generatedSeed)
		open = false
	}

	$effect(() => {
		if (open) {
			handleOpen()
		}
	})
</script>

<Modal bind:open>
	<Vertical --vertical-gap="var(--padding)" style="padding: var(--padding)">
		<Horizontal --horizontal-justify-content="space-between">
			<Typography variant="h5">Generate secret seed</Typography>
			<Button variant="ghost" dimension="compact" onclick={() => (open = false)}
				><CloseLarge size={20} /></Button
			>
		</Horizontal>
		<Input variant="outline" dimension="compact" value={generatedSeed} label="Secret Seed" readonly>
			{#snippet buttons()}
				<CopyButton text={generatedSeed} />
				<Button
					dimension="compact"
					variant="ghost"
					onclick={() => {
						generatedSeed = generateSecretSeed()
					}}
				>
					<Renew size={20} />
				</Button>
			{/snippet}
		</Input>
		<Typography
			>The secret seed works with your ETH wallet to restore your Swarm ID account. <strong
				>Store it in a password manager or write it down and keep it in a secure location. Never
				share it with anyone.</strong
			></Typography
		>
		<Horizontal --horizontal-gap="var(--half-padding)">
			<Button dimension="compact" onclick={handleUseSeed}>Use this</Button>
		</Horizontal>
	</Vertical>
</Modal>
