// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { createConnectedAppsStorageManager, type ConnectedApp } from '@snaha/swarm-id'
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

function saveConnectedApps(data: ConnectedApp[], identityId?: string): void {
  storageManager.save(data)

  // Trigger Swarm sync for the account that owns the changed app. Resolve it
  // from the app's own `identityId` rather than the active session — the
  // connect popup mutates apps with no `currentIdentityId` set, so relying on
  // the session there would silently skip the publish (stamps avoid this by
  // passing an explicit accountId). Fall back to the session for callers that
  // don't carry an identity (e.g. legacy paths).
  const resolveIdentityId = identityId ?? sessionStore.data.currentIdentityId
  if (!resolveIdentityId) return
  const identity = identitiesStore.getIdentity(resolveIdentityId)
  if (identity) {
    triggerSync(identity.accountId.toHex())
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
    defaultConnectionTime: number | undefined,
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
        connectedUntil:
          defaultConnectionTime !== undefined ? now + defaultConnectionTime : undefined,
        updatedAt: now,
        // Reconnecting clears any prior revocation tombstone.
        revokedAt: undefined,
      }
      connectedApps = connectedApps.map((app) =>
        app.appUrl === existingApp.appUrl && app.identityId === existingApp.identityId
          ? updatedApp
          : app,
      )
      saveConnectedApps(connectedApps, appData.identityId)
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
        connectedUntil:
          defaultConnectionTime !== undefined ? now + defaultConnectionTime : undefined,
        updatedAt: now,
      }
      connectedApps = [...connectedApps, newApp]
      saveConnectedApps(connectedApps, appData.identityId)
      return newApp
    }
  },

  getApp(appUrl: string): ConnectedApp | undefined {
    return connectedApps.find((app) => app.appUrl === appUrl)
  },

  // Get a connected app for a specific appUrl and identityId if the connection is still valid
  getValidConnection(appUrl: string, identityId: string): ConnectedApp | undefined {
    const app = connectedApps.find((a) => a.appUrl === appUrl && a.identityId === identityId)
    if (!app || app.revokedAt) return undefined
    if (!app.connectedUntil || !app.appSecret) return undefined
    if (app.connectedUntil <= Date.now()) return undefined
    return app
  },

  // Get identity IDs that have connected to a specific app URL (excluding
  // revoked tombstones).
  getConnectedIdentityIds(appUrl: string): string[] {
    return [
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Set is ephemeral, used only for deduplication
      ...new Set(
        connectedApps
          .filter((app) => app.appUrl === appUrl && !app.revokedAt)
          .map((app) => app.identityId),
      ),
    ]
  },

  // Get apps sorted by most recently connected
  getRecentApps(): ConnectedApp[] {
    return [...connectedApps].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
  },

  // Get apps for a specific identity, INCLUDING revoked tombstones. Used to
  // build the synced snapshot so revocations propagate to other devices.
  getAppsByIdentityId(identityId: string): ConnectedApp[] {
    return connectedApps.filter((app) => app.identityId === identityId)
  },

  // Get the displayable (non-revoked) apps for a specific identity. Used by the
  // UI so revoked tombstones stay hidden.
  getActiveAppsByIdentityId(identityId: string): ConnectedApp[] {
    return connectedApps.filter((app) => app.identityId === identityId && !app.revokedAt)
  },

  removeAppsByIdentityId(identityId: string) {
    connectedApps = connectedApps.filter((app) => app.identityId !== identityId)
    saveConnectedApps(connectedApps, identityId)
  },

  removeApp(appUrl: string, identityId: string) {
    connectedApps = connectedApps.filter(
      (app) => !(app.appUrl === appUrl && app.identityId === identityId),
    )
    saveConnectedApps(connectedApps, identityId)
  },

  disconnectApp(appUrl: string, identityId: string) {
    const now = Date.now()
    connectedApps = connectedApps.map((app) =>
      app.appUrl === appUrl && app.identityId === identityId
        ? {
            ...app,
            lastConnectedAt: 0,
            connectedUntil: undefined,
            updatedAt: now,
          }
        : app,
    )
    saveConnectedApps(connectedApps, identityId)
  },

  /**
   * Revoke an app: keep the entry as a tombstone (`revokedAt`) so the removal
   * propagates to other devices via the LWW merge, but clear the session
   * (`appSecret`/`connectedUntil`) so it no longer authenticates and is hidden
   * from the UI. (Hard removal can't propagate — the union/LWW merge would just
   * re-add it from a peer snapshot.)
   */
  revokeApp(appUrl: string, identityId: string) {
    const now = Date.now()
    connectedApps = connectedApps.map((app) =>
      app.appUrl === appUrl && app.identityId === identityId
        ? {
            ...app,
            appSecret: undefined,
            connectedUntil: undefined,
            lastConnectedAt: 0,
            revokedAt: now,
            updatedAt: now,
          }
        : app,
    )
    saveConnectedApps(connectedApps, identityId)
  },

  /**
   * Replace the connected apps belonging to a set of identities with a freshly-
   * merged set pulled from Swarm, WITHOUT firing `triggerSync` (refresh data
   * shouldn't be re-published). `connectedUntil` is preserved as-is from the
   * merge; callers reset it for restored sessions if needed.
   */
  applyRefreshed(accountIdentityIds: string[], accountApps: ConnectedApp[]) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral dedupe set
    const idSet = new Set(accountIdentityIds)
    connectedApps = [...connectedApps.filter((a) => !idSet.has(a.identityId)), ...accountApps]
    storageManager.save(connectedApps)
  },

  clear() {
    connectedApps = []
    storageManager.clear()
  },
}

// Cross-context sync: when another same-origin context (e.g. the transient
// connect popup) changes connected apps, refresh our in-memory copy — fixes the
// "had to refresh to see the app" staleness — and publish for each affected
// account. The cross-tab write lock (`withBatchWriteLock` in sync-account)
// ensures only one context actually uploads. Loop-safe: a publish reads
// connected apps but never writes them, and `storage` events don't fire in the
// writing context.
if (browser) {
  storageManager.subscribe((apps) => {
    connectedApps = apps
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral set
    const accountIds = new Set<string>()
    for (const app of apps) {
      const identity = identitiesStore.getIdentity(app.identityId)
      if (identity) accountIds.add(identity.accountId.toHex())
    }
    for (const accountId of accountIds) {
      triggerSync(accountId)
    }
  })
}
