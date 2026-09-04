// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The chain the wallet was last put on, so that a switch which would only put
 * it there again is skipped.
 *
 * `switchWalletChain` buys a genesis read on the Gnosis chain, which is the
 * selection the payment dialog opens on whenever the direct rail resolves;
 * connect and Pay would otherwise each buy one in turn, back to back on the
 * same provider with nothing between them that can change the answer.
 *
 * A record, not proof of where the wallet is. `switchWalletChain` accepts a
 * wallet that will not answer its probe, and a wallet moved between two
 * networks wearing one chain id has no event to announce it — so what is
 * remembered here can be stale. That is safe because the record decides no
 * payment: every rail that signs on a chain two networks answer to reads
 * genesis itself, right before signing (`executeDirectPayment`, and the Relay
 * rail's Gnosis source). What a stale record costs is the prompt and the probe
 * it skips, and a refusal in words at Pay where a fresh switch might have
 * repaired the network — never a payment signed on the wrong network.
 */
import type { Chain } from 'viem'

import { type EthereumProvider, switchWalletChain } from '$lib/payment/payment-rail'

export function createWalletChainRecord() {
  let recorded: number | undefined
  return {
    /**
     * Put the wallet on `chainId` unless it is recorded as already there.
     * Rejects the way `switchWalletChain` does and records nothing then: a
     * refusal is the caller's to interpret, and the next call asks again.
     *
     * Written after the switch resolves, deliberately. A wallet announces the
     * switch it was asked for while the request is still pending, and the
     * caller forgets on that event; a record that did not outlive it would
     * never be written for a wallet that had to move — the common case at
     * connect — and Pay would prove the chain again every time.
     */
    async ensure(provider: EthereumProvider, chainId: number, chains: Chain[]): Promise<void> {
      if (recorded === chainId) {
        return
      }
      await switchWalletChain(provider, chainId, chains)
      recorded = chainId
    },
    /** The wallet moved, or a new one arrived: where it is, is not known. */
    forget(): void {
      recorded = undefined
    },
  }
}
