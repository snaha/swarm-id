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

import { deriveSecret } from "../utils/key-derivation"
import { hexToUint8Array } from "../utils/hex"

const BUS_TOPIC_CONTEXT = "swarm-id/account-bus/topic/v1"
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
  const keyHex = await deriveSecret(derivationKey, BUS_ENCRYPTION_CONTEXT)
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    hexToUint8Array(keyHex),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
  return { topic, encryptionKey }
}
