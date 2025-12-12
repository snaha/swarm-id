import type { ConnectedApp } from '$lib/types'

const STORAGE_KEY = 'swarm-connected-apps'

// Load connected apps from localStorage
function loadConnectedApps(): ConnectedApp[] {
	if (typeof window === 'undefined') return []
	const stored = localStorage.getItem(STORAGE_KEY)
	return stored ? JSON.parse(stored) : []
}

// Save connected apps to localStorage
function saveConnectedApps(apps: ConnectedApp[]) {
	if (typeof window === 'undefined') return
	localStorage.setItem(STORAGE_KEY, JSON.stringify(apps))
}

// Reactive state using Svelte 5 runes
let connectedApps = $state<ConnectedApp[]>(loadConnectedApps())

export const connectedAppsStore = {
	get apps() {
		return connectedApps
	},

	// Add or update a connected app (updates lastConnectedAt if app already exists with same identity)
	addOrUpdateApp(
		appData: Omit<ConnectedApp, 'lastConnectedAt'> & {
			appIcon?: string
			appDescription?: string
		},
	): ConnectedApp {
		const existingApp = connectedApps.find(
			(app) => app.appUrl === appData.appUrl && app.identityId === appData.identityId,
		)

		if (existingApp) {
			// Update existing app
			const updatedApp: ConnectedApp = {
				...existingApp,
				appName: appData.appName,
				appIcon: appData.appIcon ?? existingApp.appIcon,
				appDescription: appData.appDescription ?? existingApp.appDescription,
				lastConnectedAt: Date.now(),
			}
			connectedApps = connectedApps.map((app) =>
				app.appUrl === existingApp.appUrl && app.identityId === existingApp.identityId
					? updatedApp
					: app,
			)
			saveConnectedApps(connectedApps)
			return updatedApp
		} else {
			// Add new app
			const newApp: ConnectedApp = {
				appUrl: appData.appUrl,
				appName: appData.appName,
				identityId: appData.identityId,
				appIcon: appData.appIcon,
				appDescription: appData.appDescription,
				lastConnectedAt: Date.now(),
			}
			connectedApps = [...connectedApps, newApp]
			saveConnectedApps(connectedApps)
			return newApp
		}
	},

	getApp(appUrl: string): ConnectedApp | undefined {
		return connectedApps.find((app) => app.appUrl === appUrl)
	},

	// Get identity IDs that have connected to a specific app URL
	getConnectedIdentityIds(appUrl: string): string[] {
		return [
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Set is ephemeral, used only for deduplication
			...new Set(connectedApps.filter((app) => app.appUrl === appUrl).map((app) => app.identityId)),
		]
	},

	// Get apps sorted by most recently connected
	getRecentApps(): ConnectedApp[] {
		return [...connectedApps].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
	},

	// Get apps for a specific identity
	getAppsByIdentityId(identityId: string): ConnectedApp[] {
		return connectedApps.filter((app) => app.identityId === identityId)
	},

	removeApp(appUrl: string, identityId: string) {
		connectedApps = connectedApps.filter(
			(app) => !(app.appUrl === appUrl && app.identityId === identityId),
		)
		saveConnectedApps(connectedApps)
	},

	clear() {
		connectedApps = []
		saveConnectedApps(connectedApps)
	},
}
