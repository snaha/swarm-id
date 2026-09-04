// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"

import {
  accountDeltaSnapshot,
  restoreLocalSessionFields,
} from "./account-delta"
import { AccountDeltaMessageSchema } from "./messages"
import { mergeConnectedApps } from "../sync/merge-snapshot"
import type { ConnectedApp } from "../schemas"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"

const APP_URL = "https://app.example"
const ACCOUNT_ID = "aa".repeat(20)

const CONNECTED_AT = 1_000_000
const SESSION_END = 9_000_000
const LATER = 2_000_000
const EVEN_LATER = 3_000_000

/** This context's own live session: it holds the secret and the deadline. */
function localSession(overrides?: Partial<ConnectedApp>): ConnectedApp {
  return {
    appUrl: APP_URL,
    appName: "Test App",
    lastConnectedAt: CONNECTED_AT,
    appSecret: "aabb",
    connectedUntil: SESSION_END,
    ...overrides,
  }
}

/**
 * The same entry as it arrives on the bus: the publisher strips the session
 * material, so every incoming entry lacks both fields regardless of intent.
 */
function onWire(app: ConnectedApp): ConnectedApp {
  return { ...app, appSecret: undefined, connectedUntil: undefined }
}

function fold(local: ConnectedApp[], incoming: ConnectedApp[]): ConnectedApp[] {
  return restoreLocalSessionFields(mergeConnectedApps(local, incoming), local)
}

describe("restoreLocalSessionFields — a peer's Disconnect", () => {
  it("ends this context's session when the winning entry was disconnected", () => {
    // The UI's plain "Disconnect": session fields cleared, `disconnectedAt`
    // stamped, no tombstone (the app stays listed). On the wire the cleared
    // fields are
    // indistinguishable from a strip, so the disconnect needs its own marker.
    const local = localSession()
    const disconnected = onWire({
      ...local,
      disconnectedAt: LATER,
    })

    const [app] = fold([local], [disconnected])

    expect(app.appSecret).toBeUndefined()
    expect(app.connectedUntil).toBeUndefined()
  })

  it("keeps the session across a benign update", () => {
    // A per-app drive choice from another context. It rides its own clock
    // (#681) and wins the pointer without touching membership — and it is
    // nobody's logout.
    const local = localSession()
    const repointed = onWire({
      ...local,
      postageStampBatchID: new BatchId("cc".repeat(32)),
      postageStampBatchIDAt: LATER,
    })

    const [app] = fold([local], [repointed])

    expect(app.postageStampBatchID?.toHex()).toBe("cc".repeat(32))
    expect(app.appSecret).toBe("aabb")
    expect(app.connectedUntil).toBe(SESSION_END)
  })

  it("keeps the session across a reconnect made elsewhere", () => {
    // The other benign update, and the only way an app's NAME changes: the
    // metadata rides a connect, so membership moves with it.
    const local = localSession()
    const reconnected = onWire({
      ...local,
      appName: "Renamed App",
      lastConnectedAt: LATER,
    })

    const [app] = fold([local], [reconnected])

    expect(app.appName).toBe("Renamed App")
    expect(app.appSecret).toBe("aabb")
    expect(app.connectedUntil).toBe(SESSION_END)
  })

  it("keeps a session established after the disconnect", () => {
    // This context reconnected after the peer disconnected: our session is the
    // newer fact, so a late-arriving stale disconnect must not end it.
    const local = localSession({ lastConnectedAt: EVEN_LATER })
    const staleDisconnect = onWire({
      ...localSession(),
      disconnectedAt: LATER,
    })

    const [app] = fold([local], [staleDisconnect])

    expect(app.appSecret).toBe("aabb")
    expect(app.connectedUntil).toBe(SESSION_END)
  })

  it("ends the session on a revoke tombstone (Remove)", () => {
    const local = localSession()
    const removed = onWire({
      ...local,
      disconnectedAt: LATER,
      revokedAt: LATER,
    })

    const [app] = fold([local], [removed])

    expect(app.revokedAt).toBe(LATER)
    expect(app.appSecret).toBeUndefined()
    expect(app.connectedUntil).toBeUndefined()
  })

  it("leaves an entry this context never had alone", () => {
    const other = onWire(localSession({ appUrl: "https://other.example" }))

    const [app] = fold([], [other])

    expect(app.appSecret).toBeUndefined()
  })
})

describe("accountDeltaSnapshot", () => {
  function snapshot(connectedApps: ConnectedApp[]): AccountStateSnapshot {
    return {
      version: 1,
      timestamp: CONNECTED_AT,
      accountId: ACCOUNT_ID,
      metadata: {
        accountName: "Test Account",
        publicKey: "00".repeat(33),
        createdAt: CONNECTED_AT,
        lastModified: CONNECTED_AT,
        devices: [],
      },
      connectedApps,
      postageStamps: [],
    }
  }

  it("strips the session material but carries the disconnect marker", () => {
    const wire = accountDeltaSnapshot(
      snapshot([localSession({ disconnectedAt: LATER })]),
    )
    const parsed = AccountDeltaMessageSchema.parse({
      type: "account-delta",
      snapshot: wire,
    })

    const [app] = parsed.snapshot.connectedApps
    expect(app.disconnectedAt).toBe(LATER)
    expect("appSecret" in app).toBe(false)
    expect("connectedUntil" in app).toBe(false)
  })
})
