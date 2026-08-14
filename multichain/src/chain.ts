// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, defineChain } from "viem"
import type { Chain, PublicClient, WalletClient } from "viem"
import { createPublicClient, createWalletClient } from "viem"
import { RollingValueProvider } from "cafe-utility"
import type { MultichainSettings } from "./settings"

/**
 * Build the viem chain object from settings instead of importing the static
 * `gnosis` chain: an EIP-155 signature carries the chain id, so the id has to
 * come from whatever the endpoint actually reports.
 */
export function chainFromSettings(settings: MultichainSettings): Chain {
  return defineChain({
    id: settings.chainId,
    name: settings.chainName,
    nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
    rpcUrls: { default: { http: settings.rpcUrls } },
  })
}

export function publicClientFor(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): PublicClient {
  return createPublicClient({
    chain: chainFromSettings(settings),
    transport: http(rpcProvider.current()),
  })
}

export function walletClientFor(
  settings: MultichainSettings,
  rpcProvider: RollingValueProvider<string>,
): WalletClient {
  return createWalletClient({
    chain: chainFromSettings(settings),
    transport: http(rpcProvider.current()),
  })
}
