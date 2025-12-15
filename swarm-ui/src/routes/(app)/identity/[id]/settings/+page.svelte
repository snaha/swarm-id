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
	import { goto } from '$app/navigation'
	import routes from '$lib/routes'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { keccak256 } from 'ethers'
	import { hexToUint8Array } from '$lib/utils/key-derivation'
	import { connectAndSign } from '$lib/ethereum'
	import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
	import type { Account } from '$lib/types'

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

	async function getMasterKeyFromAccount(acc: Account): Promise<string> {
		if (acc.type === 'passkey') {
			const swarmIdDomain = window.location.hostname
			const challenge = hexToUint8Array(keccak256(new TextEncoder().encode(swarmIdDomain)))
			// Use allowCredentials to guide WebAuthn to the correct passkey
			const passkeyAccount = await authenticateWithPasskey({
				rpId: swarmIdDomain,
				challenge,
				allowCredentials: [{ id: acc.credentialId, type: 'public-key' }],
			})
			return passkeyAccount.masterKey
		} else {
			const signed = await connectAndSign()
			const encryptionKey = await deriveEncryptionKey(signed.publicKey, acc.encryptionSalt)
			return await decryptMasterKey(acc.encryptedMasterKey, encryptionKey)
		}
	}

	async function handleCreateNewIdentity() {
		if (!account) return
		try {
			const masterKey = await getMasterKeyFromAccount(account)
			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(masterKey)
			goto(routes.IDENTITY_NEW)
		} catch (err) {
			console.error('Failed to authenticate:', err)
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
		<Button variant="ghost" dimension="compact" onclick={handleCreateNewIdentity}>Create new identity</Button
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
