import type { Account, Identity, ConnectedApp, PostageStamp } from '@swarm-id/lib'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { identitiesStore } from '$lib/stores/identities.svelte'
import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'

interface RestoreData {
  account: Account
  identities: Identity[]
  connectedApps: ConnectedApp[]
  postageStamps: PostageStamp[]
}

export function restoreAccountToStores(data: RestoreData): Account {
  accountsStore.addAccount(data.account)

  for (const identity of data.identities) {
    identitiesStore.addIdentity(identity)
  }

  for (const app of data.connectedApps) {
    // Reset connectedUntil — the session has logically expired by the time
    // a backup is restored, so apps appear as "previously connected" but
    // require the user to reconnect (which re-establishes the session timer).
    connectedAppsStore.addOrUpdateApp({ ...app, connectedUntil: undefined }, undefined)
  }

  for (const stamp of data.postageStamps) {
    try {
      postageStampsStore.addStamp(stamp)
    } catch (err) {
      console.warn('Skipping duplicate stamp:', err)
    }
  }

  return data.account
}
