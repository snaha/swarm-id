// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Objects } from "cafe-utility"

/** Contract addresses the machinery talks to. */
export interface MultichainAddresses {
  bzz: `0x${string}`
  postageStamp: `0x${string}`
  wxdai: `0x${string}`
  /**
   * Gnosis USDC — the bridged one (symbol `USDC`), NOT `USDC.e` at
   * `0x2a22…`. Only this one has a BZZ pool; USDC.e has none, so routing a
   * swap through it would revert.
   */
  usdc: `0x${string}`
  sushiV3Router: `0x${string}`
  /**
   * The EIP-7702 delegate an owner EOA authorises to run a postage operation as
   * one atomic bundle. `Simple7702Account` (eth-infinitism's audited minimal
   * 7702 account, verified on Gnosis) — it restricts execution to the account
   * itself, so only a self-call from the EOA can drive it.
   */
  eip7702Delegate: `0x${string}`
  sushiV3Quoter: `0x${string}`
}

export interface MultichainSettings {
  /** EIP-155 chain id baked into every signature. */
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
  /** Fee tier of the WXDAI/BZZ pool. */
  sushiV3BzzPoolFee: number
  /** Fee tier of the USDC/BZZ pool — the deeper of the two BZZ pools. */
  sushiV3UsdcBzzPoolFee: number
  /** Fee tier of the WXDAI/USDC pool, the first hop of a routed swap. */
  sushiV3WxdaiUsdcPoolFee: number
}

export const GNOSIS_CHAIN_ID = 100

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
    usdc: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
    sushiV3Router: "0x4F54dd2F4f30347d841b7783aD08c050d8410a9d",
    eip7702Delegate: "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9",
    sushiV3Quoter: "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e",
  },
  sushiV3BzzPoolFee: 3000,
  sushiV3UsdcBzzPoolFee: 3000,
  // The 0.01% tier. WXDAI and USDC are both dollars, so the stable-pair tier
  // is where the depth is; the 0.05% pool holds under a dollar.
  sushiV3WxdaiUsdcPoolFee: 100,
}

export function gnosisMainnetSettings(
  overrides?: Partial<MultichainSettings>,
): MultichainSettings {
  return Objects.deepMerge2(
    GNOSIS_MAINNET_DEFAULTS,
    overrides ?? {},
  ) as MultichainSettings
}
