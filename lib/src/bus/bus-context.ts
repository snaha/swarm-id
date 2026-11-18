// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account-derived bus context for off-origin transports.
 *
 * The topic names the account's room on the signaling server without being
 * linkable to the account (HMAC of the derivation key), and the encryption
 * key end-to-end encrypts every envelope — the server only ever sees
 * ciphertext. Both are derivable by exactly the contexts that hold the
 * account's `derivationKey`.
 */

import { deriveAesGcmKey, deriveSecret } from "../utils/key-derivation"

/**
 * The version is the room's protocol: everyone in a room must answer lane
 * claims (`sync/bus-lease.ts`), since a claimant waits for each member. A
 * build that speaks another protocol gets another label, and so another room.
 */
const BUS_TOPIC_CONTEXT = "swarm-id/account-bus/topic/v2"
const BUS_ENCRYPTION_CONTEXT = "swarm-id/account-bus/encryption/v1"

export interface BusContext {
  /** 64-hex room identifier, unlinkable to the account id. */
  topic: string
  /** AES-GCM-256 key for envelope encryption. */
  encryptionKey: CryptoKey
}

export async function deriveBusContext(
  derivationKey: string,
): Promise<BusContext> {
  const topic = await deriveSecret(derivationKey, BUS_TOPIC_CONTEXT)
  const encryptionKey = await deriveAesGcmKey(
    derivationKey,
    BUS_ENCRYPTION_CONTEXT,
  )
  return { topic, encryptionKey }
}
