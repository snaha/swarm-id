<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import AppList from '$lib/components/app-list.svelte'
	import { DEFAULT_SESSION_DURATION, DAY, HOUR } from '@swarm-id/lib'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { page } from '$app/state'
	import Grid from '$lib/components/ui/grid.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'

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
	{#if apps.length > 0 && identity}
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
		<AppList {apps} {identity} />
	{:else}
		<Vertical --vertical-gap="var(--half-padding)">
			<Typography bold center>No connected apps yet.</Typography>
			<Typography center>
				Visit any app that supports Swarm ID and select "Connect with Swarm ID" to get started.
			</Typography>
		</Vertical>
	{/if}
</Vertical>
