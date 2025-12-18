import { z } from 'zod'
import { browser } from '$app/environment'
import { UrlSchema, TimestampSchema, VersionedStorageSchema } from '$lib/schemas/base'

// ============================================================================
// Schema & Types
// ============================================================================

const STORAGE_KEY = 'swarm-connected-apps'
const CURRENT_VERSION = 1

const ConnectedAppSchemaV1 = z.object({
	appUrl: UrlSchema,
	appName: z.string().min(1).max(100),
	lastConnectedAt: TimestampSchema,
	identityId: z.string().min(1),
	appIcon: z.string().max(10000).optional(),
	appDescription: z.string().max(500).optional(),
})

export type ConnectedApp = z.infer<typeof ConnectedAppSchemaV1>

// ============================================================================
// Storage (versioned)
// ============================================================================

function loadConnectedApps(): ConnectedApp[] {
	if (!browser) return []
	const stored = localStorage.getItem(STORAGE_KEY)
	if (!stored) return []

	try {
		const parsed: unknown = JSON.parse(stored)
		return parse(parsed)
	} catch (e) {
		console.error('[ConnectedApps] Load failed:', e)
		return []
	}
}

function parse(parsed: unknown): ConnectedApp[] {
	const versioned = VersionedStorageSchema.safeParse(parsed)
	const version = versioned.success ? versioned.data.version : 0
	const data = versioned.success ? versioned.data.data : parsed

	switch (version) {
		case 0: // Legacy unversioned data
		case 1: {
			const result = z.array(ConnectedAppSchemaV1).safeParse(data)
			if (!result.success) {
				console.error('[ConnectedApps] Invalid data:', result.error.format())
				return []
			}
			return result.data
		}
		default:
			console.error(`[ConnectedApps] Unknown version: ${version}`)
			return []
	}
}

function saveConnectedApps(data: ConnectedApp[]): void {
	if (!browser) return
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, data }))
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
		if (browser) localStorage.removeItem(STORAGE_KEY)
	},
}
