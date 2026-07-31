// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Objects } from "cafe-utility"

/**
 * Contract addresses the machinery talks to. The Sushi trio is optional: the
 * bee-compose anvil chain deploys the PostageStamp and a BZZ test token but no
 * DEX, so swap operations are unavailable there (see requireSushi in sushi.ts)
 * and callers mock the swap leg instead.
 */
export interface MultichainAddresses {
  bzz: `0x${string}`
  postageStamp: `0x${string}`
  wxdai?: `0x${string}`
  sushiV3Router?: `0x${string}`
  sushiV3Quoter?: `0x${string}`
}

export interface MultichainSettings {
  /** EIP-155 chain id baked into every signature — 100 mainnet, 4020 anvil. */
  chainId: number
  chainName: string
  /** Rotated on transport failures (RollingValueProvider). */
  rpcUrls: string[]
  fetchTimeoutMillis: number
  receiptPollMillis: number
  receiptPollAttempts: number
  balancePollMillis: number
  balancePollAttempts: number
  addresses: MultichainAddresses
  sushiV3BzzPoolFee: number
}

export const GNOSIS_CHAIN_ID = 100
export const LOCAL_ANVIL_CHAIN_ID = 4020

const GNOSIS_MAINNET_DEFAULTS: MultichainSettings = {
  chainId: GNOSIS_CHAIN_ID,
  chainName: "Gnosis",
  rpcUrls: ["https://rpc.gnosischain.com", "https://xdai.fairdatasociety.org"],
  fetchTimeoutMillis: 15_000,
  // Gnosis blocks every ~5s; a receipt normally lands within one or two.
  receiptPollMillis: 5_000,
  receiptPollAttempts: 12,
  balancePollMillis: 15_000,
  balancePollAttempts: 20,
  addresses: {
    bzz: "0xdbf3ea6f5bee45c02255b2c26a16f300502f68da",
    postageStamp: "0x45a1502382541Cd610CC9068e88727426b696293",
    wxdai: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
    sushiV3Router: "0x4F54dd2F4f30347d841b7783aD08c050d8410a9d",
    sushiV3Quoter: "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e",
  },
  sushiV3BzzPoolFee: 3000,
}

// bee-compose anvil deploy (see .claude/rules/bee-cluster.md): PostageStamp and
// a BZZ TestToken at deterministic CREATE addresses; no DEX exists locally.
const LOCAL_ANVIL_DEFAULTS: MultichainSettings = {
  chainId: LOCAL_ANVIL_CHAIN_ID,
  chainName: "bee-compose anvil",
  rpcUrls: ["http://localhost:9545"],
  fetchTimeoutMillis: 15_000,
  receiptPollMillis: 1_000,
  receiptPollAttempts: 20,
  balancePollMillis: 1_000,
  balancePollAttempts: 20,
  addresses: {
    bzz: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    postageStamp: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  },
  sushiV3BzzPoolFee: 3000,
}

export function gnosisMainnetSettings(
  overrides?: Partial<MultichainSettings>,
): MultichainSettings {
  return Objects.deepMerge2(
    GNOSIS_MAINNET_DEFAULTS,
    overrides ?? {},
  ) as MultichainSettings
}

export function localAnvilSettings(
  overrides?: Partial<MultichainSettings>,
): MultichainSettings {
  return Objects.deepMerge2(
    LOCAL_ANVIL_DEFAULTS,
    overrides ?? {},
  ) as MultichainSettings
}
