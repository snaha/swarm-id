import { browser } from '$app/environment'
import { createConnectedAppsStorageManager, type ConnectedApp } from '@swarm-id/lib'
import { triggerSync } from '$lib/utils/sync-hooks'
import { sessionStore } from './session.svelte'
import { identitiesStore } from './identities.svelte'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createConnectedAppsStorageManager()

function loadConnectedApps(): ConnectedApp[] {
	if (!browser) return []
	return storageManager.load()
}

function saveConnectedApps(data: ConnectedApp[]): void {
	storageManager.save(data)

	// Trigger Swarm sync for current identity's account
	const currentIdentityId = sessionStore.data.currentIdentityId
	if (currentIdentityId) {
		const identity = identitiesStore.getIdentity(currentIdentityId)
		if (identity) {
			triggerSync(identity.accountId.toHex())
		}
	}
}

// ============================================================================
// Reactive Store
// ============================================================================

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
			appSecret?: string
		},
		defaultConnectionTime: number,
	): ConnectedApp {
		const existingApp = connectedApps.find(
			(app) => app.appUrl === appData.appUrl && app.identityId === appData.identityId,
		)

		const now = Date.now()
		if (existingApp) {
			// Update existing app
			const updatedApp: ConnectedApp = {
				...existingApp,
				appName: appData.appName,
				appIcon: appData.appIcon ?? existingApp.appIcon,
				appDescription: appData.appDescription ?? existingApp.appDescription,
				appSecret: appData.appSecret ?? existingApp.appSecret,
				lastConnectedAt: now,
				connectedUntil: now + defaultConnectionTime,
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
				appSecret: appData.appSecret,
				lastConnectedAt: now,
				connectedUntil: now + defaultConnectionTime,
			}
			connectedApps = [...connectedApps, newApp]
			saveConnectedApps(connectedApps)
			return newApp
		}
	},

	getApp(appUrl: string): ConnectedApp | undefined {
		return connectedApps.find((app) => app.appUrl === appUrl)
	},

	// Get a connected app for a specific appUrl and identityId if the connection is still valid
	getValidConnection(appUrl: string, identityId: string): ConnectedApp | undefined {
		const app = connectedApps.find((a) => a.appUrl === appUrl && a.identityId === identityId)
		if (!app?.connectedUntil || !app.appSecret) return undefined
		if (app.connectedUntil <= Date.now()) return undefined
		return app
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

	disconnectApp(appUrl: string, identityId: string) {
		connectedApps = connectedApps.map((app) =>
			app.appUrl === appUrl && app.identityId === identityId
				? {
						...app,
						lastConnectedAt: 0,
						connectedUntil: undefined,
					}
				: app,
		)
		saveConnectedApps(connectedApps)
	},

	clear() {
		connectedApps = []
		storageManager.clear()
	},
}
