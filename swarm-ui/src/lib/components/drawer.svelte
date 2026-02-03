<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import { page } from '$app/state'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import routes from '$lib/routes'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import CreateIdentityButton from '$lib/components/create-identity-button.svelte'
	import { notImplemented } from '$lib/utils/not-implemented'
	import {
		Add,
		Checkmark,
		ChevronLeft,
		ChevronRight,
		CloseLarge,
		IbmCloudHyperProtectCryptoServices,
		Information,
		Rocket,
		TrashCan,
	} from 'carbon-icons-svelte'
	import NetworkSettingsModal from './network-settings-modal.svelte'
	import ThemeToggle from './theme-toggle.svelte'
	import FlexItem from '$lib/components/ui/flex-item.svelte'
	import Divider from '$lib/components/ui/divider.svelte'
	import Badge from '$lib/components/ui/badge.svelte'
	import type { Account, Identity } from '$lib/types'
	import EthereumLogo from './ethereum-logo.svelte'
	import PasskeyLogo from './passkey-logo.svelte'
	import Input from './ui/input/input.svelte'
	import Typography from './ui/typography.svelte'
	import CopyButton from './copy-button.svelte'
	import Tooltip from './ui/tooltip.svelte'
	import ViewGenerationDetailsModal from './view-generation-details-modal.svelte'

	type Props = {
		drawerOpen: boolean
		account: Account
		identities: Identity[]
		identityId?: string
	}

	let { drawerOpen = $bindable(), identities, account, identityId }: Props = $props()

	let screen = $state<'main' | 'all-accounts' | 'account-details'>('main')
	// eslint-disable-next-line svelte/prefer-writable-derived
	let accountName = $state('')
	let showUpgradeTooltip = $state(false)
	let networkSettingsModalOpen = $state(false)
	let showGenerationDetailsModal = $state(false)

	$effect(() => {
		accountName = account.name
	})

	function handleIdentityClick(clickedIdentity: (typeof identities)[number]) {
		const currentPath = page.url.pathname

		// Determine which page we're on and navigate to the same page type with the new identity
		if (currentPath.includes('/apps')) {
			goto(resolve(routes.IDENTITY_APPS, { id: clickedIdentity.id }))
		} else if (currentPath.includes('/stamps')) {
			goto(resolve(routes.IDENTITY_STAMPS, { id: clickedIdentity.id }))
		} else if (currentPath.includes('/settings')) {
			goto(resolve(routes.IDENTITY_SETTINGS, { id: clickedIdentity.id }))
		} else {
			goto(resolve(routes.IDENTITY_APPS, { id: clickedIdentity.id }))
		}
	}

	function selectAccount(acc: Account) {
		const firstAccountIdentity = identities.find((identity) => identity.accountId === acc.id)
		if (firstAccountIdentity) {
			handleIdentityClick(firstAccountIdentity)
		}
	}

	function onAccountNameChange() {
		accountsStore.setAccountName(account.id, accountName)
	}
</script>

{#if drawerOpen}
	<div class="drawer">
		<Vertical --vertical-gap="0">
			{#if screen === 'main'}
				<Horizontal
					--horizontal-gap="var(--double-padding)"
					--horizontal-justify-content="space-between"
					--horizontal-align-items="center"
					style="padding: var(--padding)"
				>
					<Horizontal --horizontal-gap="var(--half-padding)">
						{account.type === 'ethereum' ? 'Ethereum' : 'Passkey'}
						<Badge>Local</Badge>
					</Horizontal>
					<Button variant="ghost" dimension="compact" onclick={() => (drawerOpen = false)}
						><CloseLarge size={20} /></Button
					>
				</Horizontal>

				<div style="padding: 0 var(--padding);">
					<IdentityList
						{identities}
						currentIdentityId={identityId}
						onIdentityClick={handleIdentityClick}
						showBorder={false}
						showArrow={false}
					/>
				</div>

				<Vertical
					--vertical-gap="0"
					--vertical-align-items="stretch"
					style="padding: var(--padding)"
				>
					<CreateIdentityButton {account} showIcon={false} />
					<Button variant="ghost" dimension="compact" onclick={() => (screen = 'account-details')}>
						<Horizontal
							--horizontal-gap="var(--half-padding)"
							--horizontal-align-items="center"
							--horizontal-justify-content="stretch"
							style="flex: 1"
						>
							Account details
							<FlexItem />
							<ChevronRight size={20} />
						</Horizontal></Button
					>
				</Vertical>
				<Divider --margin="0" />
				<Vertical
					--vertical-gap="0"
					--vertical-align-items="stretch"
					style="padding: var(--padding)"
				>
					<Button variant="ghost" dimension="compact" onclick={() => (screen = 'all-accounts')}>
						<Horizontal
							--horizontal-gap="var(--half-padding)"
							--horizontal-align-items="center"
							--horizontal-justify-content="stretch"
							style="flex: 1"
						>
							All accounts
							<FlexItem />
							<ChevronRight size={20} />
						</Horizontal></Button
					>
				</Vertical>
				<Divider --margin="0" />
				<Vertical
					--vertical-gap="0"
					--vertical-align-items="stretch"
					style="padding: var(--padding)"
				>
					<Button
						variant="ghost"
						dimension="compact"
						onclick={() => (networkSettingsModalOpen = true)}
					>
						<Horizontal
							--horizontal-gap="var(--half-padding)"
							--horizontal-align-items="center"
							--horizontal-justify-content="stretch"
							style="flex: 1"
						>
							Network settings
						</Horizontal></Button
					>
				</Vertical>
				<Divider --margin="0" />
				<Vertical
					--vertical-gap="0"
					--vertical-align-items="stretch"
					style="padding: var(--padding)"
				>
					<Horizontal
						--horizontal-gap="var(--half-padding)"
						--horizontal-align-items="center"
						--horizontal-justify-content="stretch"
						style="flex: 1;"
					>
						<Typography style="padding: var(--half-padding)">Appearance</Typography>
						<FlexItem />
						<ThemeToggle />
					</Horizontal>
				</Vertical>
			{:else if screen === 'all-accounts'}
				<Horizontal
					--horizontal-gap="var(--double-padding)"
					--horizontal-justify-content="space-between"
					--horizontal-align-items="center"
					style="padding: var(--padding)"
				>
					<Horizontal --horizontal-gap="var(--half-padding)">
						<Button variant="ghost" dimension="compact" onclick={() => (screen = 'main')}
							><ChevronLeft size={20} /></Button
						>
						All accounts
					</Horizontal>
					<Button variant="ghost" dimension="compact" onclick={() => (drawerOpen = false)}
						><CloseLarge size={20} /></Button
					>
				</Horizontal>
				<Vertical --vertical-gap="0" style="padding: var(--padding)">
					{#each accountsStore.accounts as acc (acc.id)}
						<Button variant="ghost" dimension="compact" onclick={() => selectAccount(acc)}>
							<Horizontal
								--horizontal-gap="var(--half-padding)"
								--horizontal-align-items="center"
								--horizontal-justify-content="stretch"
								style="flex: 1"
							>
								{#if acc.type === 'ethereum'}
									<EthereumLogo size={20} />
								{:else}
									<PasskeyLogo size={20} />
								{/if}
								{acc.name}
								<FlexItem />
								{#if account.id === acc.id}
									<Checkmark size={20} />
								{/if}
							</Horizontal>
						</Button>
					{/each}
				</Vertical>
				<Divider --margin="0" />
				<Vertical
					--vertical-gap="0"
					--vertical-align-items="stretch"
					style="padding: var(--padding)"
				>
					<Button
						variant="ghost"
						dimension="compact"
						onclick={() => {
							drawerOpen = false
							goto(resolve(routes.ACCOUNT_NEW))
						}}
					>
						<Horizontal
							--horizontal-gap="var(--half-padding)"
							--horizontal-align-items="center"
							--horizontal-justify-content="stretch"
							style="flex: 1"
						>
							<Add size={20} />
							Add account
						</Horizontal></Button
					>
				</Vertical>
			{:else if screen === 'account-details'}
				<Horizontal
					--horizontal-gap="var(--double-padding)"
					--horizontal-justify-content="space-between"
					--horizontal-align-items="center"
					style="padding: var(--padding)"
				>
					<Horizontal --horizontal-gap="var(--half-padding)">
						<Button variant="ghost" dimension="compact" onclick={() => (screen = 'main')}
							><ChevronLeft size={20} /></Button
						>
						Account details
					</Horizontal>
					<Button variant="ghost" dimension="compact" onclick={() => (drawerOpen = false)}
						><CloseLarge size={20} /></Button
					>
				</Horizontal>
				<Vertical --vertical-gap="var(--padding)" style="padding: 0 var(--padding)">
					<Vertical --vertical-gap="var(--half-padding)">
						<Input
							variant="outline"
							dimension="compact"
							name="id-name"
							bind:value={accountName}
							class="grower"
							label="Account name"
							oninput={onAccountNameChange}
						/>
						<Horizontal --horizontal-gap="var(--quarter-padding)">
							{#if account.type === 'ethereum'}
								<EthereumLogo size={20} />Ethereum
							{:else}
								<PasskeyLogo size={20} />Passkey
							{/if}
						</Horizontal>
					</Vertical>
					<Vertical --vertical-gap="var(--quarter-padding)">
						<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="end">
							<Input
								variant="outline"
								dimension="compact"
								value={account.id.toHex()}
								class="grower"
								label="Account address"
								disabled
							/>
							<div style="border: 1px solid transparent">
								<CopyButton text={account.id.toHex()} />
							</div>
						</Horizontal>
						<Typography variant="small">Used to buy and own stamps</Typography>
					</Vertical>
					<Input
						variant="outline"
						dimension="compact"
						value="Local"
						class="grower"
						label="Account type"
						disabled
						helperText="Limited to viewing only. Upgrade to synced account to upload content and sync across devices."
					/>
				</Vertical>

				<Vertical
					--vertical-gap="0"
					--vertical-align-items="stretch"
					--vertical-justify-content="stretch"
					style="padding: var(--padding)"
				>
					{#if account.type === 'ethereum'}
						<Button
							variant="ghost"
							dimension="compact"
							onclick={() => {
								showGenerationDetailsModal = true
							}}
							leftAlign
						>
							<IbmCloudHyperProtectCryptoServices size={20} />
							View Generation Details
						</Button>
					{/if}

					<Horizontal
						--horizontal-gap="var(--half-padding)"
						--horizontal-align-items="stretch"
						--horizontal-justify-content="stretch"
						class="grower"
					>
						<Button variant="ghost" dimension="compact" onclick={notImplemented} flexGrow leftAlign>
							<Rocket size={20} />
							Upgrade account
							<FlexItem />
						</Button>
						<Tooltip
							show={showUpgradeTooltip}
							position="top"
							variant="small"
							color="dark"
							maxWidth="279px"
						>
							<Button
								variant="ghost"
								dimension="small"
								onmouseenter={() => (showUpgradeTooltip = true)}
								onmouseleave={() => (showUpgradeTooltip = false)}
								onclick={(e: MouseEvent) => {
									e.stopPropagation()
									showUpgradeTooltip = !showUpgradeTooltip
								}}
							>
								<Information size={16} />
							</Button>
							{#snippet helperText()}
								Upgrading requires a Swarm postage stamp. You'll be able to upload content to Swarm
								and access your account from any device.
							{/snippet}
						</Tooltip>
					</Horizontal>
					<Button variant="ghost" dimension="compact" danger leftAlign onclick={notImplemented}>
						<TrashCan size={20} />
						Delete account
					</Button>
				</Vertical>
			{/if}
		</Vertical>
	</div>
{/if}
{#if account.type === 'ethereum'}
	<ViewGenerationDetailsModal
		bind:open={showGenerationDetailsModal}
		bind:drawerOpen
		{account}
		onClose={() => (showGenerationDetailsModal = false)}
	/>
{/if}

<NetworkSettingsModal bind:open={networkSettingsModalOpen} />

<style>
	.drawer {
		position: absolute;
		top: var(--double-padding);
		right: var(--double-padding);
		width: 360px;
		max-height: calc(100dvh - 2 * var(--double-padding));
		background: var(--colors-base);
		border-left: 1px solid var(--colors-low);
		padding: 0;
		overflow-y: auto;
		z-index: 50;
		box-shadow: 0px 4px 12px 4px var(--colors-dark-25);
	}
</style>
