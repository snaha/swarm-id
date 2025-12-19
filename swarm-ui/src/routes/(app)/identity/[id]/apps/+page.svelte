<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import AppList from '$lib/components/app-list.svelte'
	import { connectedAppsStore, DEFAULT_SESSION_DURATION } from '$lib/stores/connected-apps.svelte'
	import { page } from '$app/state'
	import Grid from '$lib/components/ui/grid.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import Toggle from '$lib/components/ui/toggle.svelte'
	import { BatchId } from '@ethersphere/bee-js'
	import { toPrefixedHex } from '$lib/utils/hex'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { DAY, HOUR } from '$lib/time'

	const identityId = $derived(page.params.id)
	const apps = $derived(identityId ? connectedAppsStore.getAppsByIdentityId(identityId) : [])
	const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)

	let sessionDurationValue = $state(sessionDurationToValue(DEFAULT_SESSION_DURATION))

	$effect(() => {
		if (identity) {
			const appSessionDuration = identity.settings?.appSessionDuration ?? DEFAULT_SESSION_DURATION
			sessionDurationValue = sessionDurationToValue(appSessionDuration)
		}
	})

	function onSessionDurationChange() {
		if (identity) {
			const appSessionDuration = valueToSessionDuration(sessionDurationValue)
			identitiesStore.updateIdentity(identity.id, {
				settings: {
					...identity.settings,
					appSessionDuration,
				},
			})
		}
	}

	function sessionDurationToValue(duration: number) {
		switch (duration) {
			case 0:
				return 'session'
			case 24 * HOUR:
				return '24h'
			case 7 * DAY:
				return '7d'
			case 30 * DAY:
				return '30d'
			default:
				return '30d'
		}
	}

	function valueToSessionDuration(value: string) {
		switch (value) {
			case 'session':
				return 0
			case '24h':
				return 24 * HOUR
			case '7d':
				return 7 * DAY
			case '30d':
				return 30 * DAY
			default:
				return DEFAULT_SESSION_DURATION
		}
	}
</script>

<Vertical --vertical-gap="var(--padding)" style="padding-top: var(--double-padding);">
	<Grid>
		<!-- Row 1-->
		<Typography>Keep apps connected for</Typography>
		<Select
			dimension="compact"
			bind:value={sessionDurationValue}
			items={[
				{ value: 'session', label: 'Current session' },
				{ value: '24h', label: '24 hours' },
				{ value: '7d', label: '7 days' },
				{ value: '30d', label: '30 days' },
			]}
			onchange={onSessionDurationChange}
		></Select>
	</Grid>
	{#if apps.length > 0 && identity}
		<AppList {apps} {identity} />
	{:else}
		<Typography variant="small" style="opacity: 0.5;">No connected apps yet.</Typography>
	{/if}
</Vertical>
