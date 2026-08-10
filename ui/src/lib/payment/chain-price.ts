// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { cachedChainRead } from '$lib/payment/chain-cache'
import { postageChain } from '$lib/payment/postage-onchain'

/** How long a fetched chain price stays fresh. The oracle price moves slowly;
 * a short cache stops every dialog open from re-hitting the RPC. */
const PRICE_TTL_MS = 60_000

/**
 * The chain's current storage price (PLUR per chunk per block), read from the
 * PostageStamp contract itself — no Bee node involved — cached briefly and
 * shared by the drive dialogs. Rejects when the RPC is unreachable — callers
 * surface that and may simply call again to retry (a failure is never cached).
 */
export const currentChainPrice = cachedChainRead(PRICE_TTL_MS, async (url) => {
  const { lastPrice } = await (await postageChain(url)).getPostageWriteConstraints()
  return lastPrice
})
