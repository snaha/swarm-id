<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import ResponsiveLayout from '$lib/components/ui/responsive-layout.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { layoutStore } from '$lib/stores/layout.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import { page } from '$app/state'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import CopyButton from '$lib/components/copy-button.svelte'
	import Divider from '$lib/components/ui/divider.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import { notImplemented } from '$lib/utils/not-implemented'

	const identityId = $derived(page.params.id)
	const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
	const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)

	let identityName = $state('')

	$effect(() => {
		if (identity) {
			identityName = identity.name
		} else {
			identityName = ''
		}
	})

	function onNameChange() {
		if (identity) {
			identitiesStore.updateIdentity(identity.id, { name: identityName })
		}
	}
</script>

<Vertical --vertical-gap="var(--double-padding)" style="padding-top: var(--double-padding);">
	<Vertical --vertical-gap="var(--padding)">
		<ResponsiveLayout
			--responsive-align-items="start"
			--responsive-justify-content="stretch"
			--responsive-gap="var(--quarter-padding)"
		>
			<Horizontal
				class={!layoutStore.mobile ? 'flex50 input-layout' : ''}
				--horizontal-gap="var(--half-padding)"><Typography>Account</Typography></Horizontal
			>
			<Input
				variant="outline"
				dimension="compact"
				name="account"
				value={account?.name}
				disabled
				class="flex50"
			/>
		</ResponsiveLayout>

		<ResponsiveLayout
			--responsive-align-items="start"
			--responsive-justify-content="stretch"
			--responsive-gap="var(--quarter-padding)"
		>
			<!-- Row 2 -->
			<Typography class={!layoutStore.mobile ? 'flex50 input-layout' : ''}
				>Identity display name</Typography
			>
			<Vertical
				class={!layoutStore.mobile ? 'flex50' : ''}
				--vertical-gap="var(--quarter-gap)"
				--vertical-align-items={layoutStore.mobile ? 'stretch' : 'start'}
			>
				<Horizontal --horizontal-gap="var(--half-padding)">
					<Input
						variant="outline"
						dimension="compact"
						name="id-name"
						bind:value={identityName}
						class="grower"
						oninput={onNameChange}
					/>
					{#if identity}
						<Hashicon value={identity.id} size={40} />
					{/if}
				</Horizontal>
			</Vertical>
		</ResponsiveLayout>

		<ResponsiveLayout
			--responsive-align-items="start"
			--responsive-justify-content="stretch"
			--responsive-gap="var(--quarter-padding)"
		>
			<Typography class={!layoutStore.mobile ? 'flex50 input-layout' : ''}
				>Identity address</Typography
			>
			<Vertical
				class={!layoutStore.mobile ? 'flex50' : ''}
				--vertical-gap="var(--quarter-gap)"
				--vertical-align-items={layoutStore.mobile ? 'stretch' : 'start'}
			>
				<Horizontal --horizontal-gap="var(--half-padding)">
					<Input
						variant="outline"
						dimension="compact"
						name="id-name"
						value={identity?.id}
						class="grower"
						disabled
					/>
					{#if identity}
						<CopyButton text={identity.id} />
					{/if}
				</Horizontal>
				<Typography variant="small">Used to buy and own stamps</Typography>
			</Vertical>
		</ResponsiveLayout>
	</Vertical>

	<Divider --margin="0" />

	<ResponsiveLayout
		--responsive-align-items="start"
		--responsive-justify-content="stretch"
		--responsive-gap="var(--quarter-padding)"
	>
		<Button variant="ghost" dimension="compact" onclick={notImplemented}>Create new identity</Button
		>
	</ResponsiveLayout>
</Vertical>

<style>
	:global(.flex50) {
		flex: 0.5;
	}
	:global(.input-layout) {
		padding: var(--half-padding) 0 !important;
		border: 1px solid transparent;
	}
</style>
