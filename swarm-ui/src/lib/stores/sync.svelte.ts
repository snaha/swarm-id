import {
	initSyncCoordinator,
	triggerSync,
	requestSync,
	destroySyncCoordinator,
} from '@swarm-id/lib'
import { browser } from '$app/environment'

if (browser) initSyncCoordinator()

export const syncStore = {
	triggerSync(accountId: string): void {
		triggerSync(accountId)
	},
	async requestSync(accountId: string): Promise<void> {
		await requestSync(accountId)
	},
	async destroy(): Promise<void> {
		await destroySyncCoordinator()
	},
}
