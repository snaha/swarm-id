export type ConnectedApp = {
	id: string
	appUrl: string
	appName: string
	lastConnectedAt: number
	identityId: string
	favicon?: string
}

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
		appData: Omit<ConnectedApp, 'id' | 'lastConnectedAt'> & { favicon?: string },
	): ConnectedApp {
		const existingApp = connectedApps.find(
			(app) => app.appUrl === appData.appUrl && app.identityId === appData.identityId,
		)

		if (existingApp) {
			// Update existing app
			const updatedApp: ConnectedApp = {
				...existingApp,
				appName: appData.appName,
				favicon: appData.favicon ?? existingApp.favicon,
				lastConnectedAt: Date.now(),
			}
			connectedApps = connectedApps.map((app) => (app.id === existingApp.id ? updatedApp : app))
			saveConnectedApps(connectedApps)
			return updatedApp
		} else {
			// Add new app
			const newApp: ConnectedApp = {
				id: crypto.randomUUID(),
				appUrl: appData.appUrl,
				appName: appData.appName,
				identityId: appData.identityId,
				favicon: appData.favicon,
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
			...new Set(connectedApps.filter((app) => app.appUrl === appUrl).map((app) => app.identityId)),
		]
	},

	// Get apps sorted by most recently connected
	getRecentApps(): ConnectedApp[] {
		return [...connectedApps].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
	},

	removeApp(id: string) {
		connectedApps = connectedApps.filter((app) => app.id !== id)
		saveConnectedApps(connectedApps)
	},

	clear() {
		connectedApps = []
		saveConnectedApps(connectedApps)
	},
}
