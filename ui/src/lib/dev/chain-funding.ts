// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DEV ONLY — stands in for the production payment flow on the local chain.
 *
 * That chain — the cluster's (`pnpm dev:local`) or the same snapshot
 * standalone (`pnpm dev:chain`) — carries a real BZZ market and the
 * PostageStamp the nodes follow, so the only faked leg is the bridge: xDAI is
 * minted with anvil's setBalance and everything after it (swap, approve,
 * createBatch) is the production path.
 *
 * It also prefunds a faucet, so handing an address what it needs is a transfer
 * rather than a trade — the BZZ pool is real and thin, and only the purchase
 * itself is worth spending it on.
 *
 * Production code must never import this module.
 */
import { EthAddress } from '@ethersphere/bee-js'
import {
  DEV_FAUCET_ADDRESS,
  ensureBundlingDelegate,
  fundLocalAccount,
  simulateWidgetPurchase,
} from '@swarm-id/multichain/dev'
import { generatePrivateKey } from 'viem/accounts'

import { mintSourceEth } from '$lib/dev/local-payment-rail'
import { fetchExistingBatchFromChain } from '$lib/payment/contract'
import { ownerFunds, postageChain } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'
import type { Account } from '$lib/types'

/**
 * Anvil's first default account — the key every anvil prints on startup, so
 * publicly known and worth nothing off a dev chain.
 *
 * Both dev chains are anvil, and anvil funds its ten default accounts at
 * genesis whether it is bare (the source chain) or loading a state dump (the
 * Gnosis one), so this address starts with 10 000 native on EACH: 10 000 ETH on
 * the fake mainnet, 10 000 xDAI on Gnosis. It holds no BZZ — that float is the
 * bake's, and sits with `DEV_FAUCET_ADDRESS`.
 *
 * Importing it is never required: the dev rail tops up whatever account
 * connects. It is only the shortcut to a wallet showing a balance from the
 * start, instead of one that looks empty until the first payment funds it.
 */
export const ANVIL_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
}

/** Default drive size for the dev batch actions. */
const DEV_BATCH_DEPTH = 20
/** Funds a dev batch well above the contract's ~24h floor. */
const DEV_BATCH_FLOOR_MULTIPLE = 3n
/** Bankrolls the simulated purchase's throwaway payer: swap, batch and gas. */
const PURCHASE_PAYER_XDAI = 2n * 10n ** 18n // 2 xDAI
/**
 * Of that, what goes into BZZ. Two orders of magnitude more than a dev batch
 * costs, so price drift on a long-lived chain cannot starve a purchase, and
 * still small against a ~$10k pool. The leftovers go to the batch owner, as
 * they do in production.
 */
const PURCHASE_SWAP_XDAI = 10n ** 18n / 4n // 0.25 xDAI

/**
 * What one faucet send delivers, across both dev chains. A zero leg is skipped
 * entirely — which is what lets an ETH-only send work with no Gnosis chain
 * running, and an xDAI/BZZ one with no source chain.
 */
export interface FaucetAmounts {
  /** Source-chain ETH, in wei — the fake mainnet the payment rail signs on. */
  eth: bigint
  /** Gnosis-side native xDAI, in wei. */
  xdai: bigint
  /** Gnosis-side BZZ, in PLUR. */
  bzzPlur: bigint
}

/**
 * Hand any address money on either dev chain, or both.
 *
 * The two legs come from different places because the chains do: on Gnosis this
 * is a transfer from the baked faucet (every swap moves a real and thin BZZ
 * pool, and topping an address up is not the thing worth simulating
 * faithfully), while the source chain has no faucet to transfer from and mints
 * instead. The purchase path still trades — see `createOwnedBatchOnChain`.
 *
 * Any address, not just a derived signer: rehearsing a payment needs ETH in
 * whatever wallet account is connected, and reproducing a bug usually means
 * funding the one address that is stuck.
 *
 * The source-chain leg goes first so that a chain that is not running aborts
 * the send before anything has moved. There is no partial delivery to explain,
 * and the fix — start it and press Send again — costs nothing.
 */
export async function sendFromFaucet(address: string, amounts: FaucetAmounts): Promise<void> {
  const to = new EthAddress(address).toChecksum() as `0x${string}`
  if (amounts.eth > 0n) {
    await mintSourceEth(to, amounts.eth)
  }
  if (amounts.xdai > 0n || amounts.bzzPlur > 0n) {
    const chain = await postageChain()
    await fundLocalAccount({ to, xdai: amounts.xdai, bzzPlur: amounts.bzzPlur }, chain.settings)
  }
}

/** An address and what it holds on the Gnosis-side chain, for the faucet panel. */
export interface FundsRow {
  address: `0x${string}`
  xdai: bigint
  bzz: bigint
}

/**
 * What the faucet has left to give, and what `address` holds.
 *
 * Gnosis-side only. Source-chain ETH is read separately (`sourceEthBalance`)
 * because the faucet has no counterpart there — anvil mints — and because that
 * chain is often not running, which must not cost the balances that are.
 */
export async function devChainFunds(
  address: string,
): Promise<{ faucet: FundsRow; recipient: FundsRow }> {
  const chain = await postageChain()
  const recipient = new EthAddress(address).toChecksum() as `0x${string}`
  const [faucetFunds, recipientFunds] = await Promise.all([
    ownerFunds(DEV_FAUCET_ADDRESS, chain),
    ownerFunds(recipient, chain),
  ])
  return {
    faucet: { address: DEV_FAUCET_ADDRESS, ...faucetFunds },
    recipient: { address: recipient, ...recipientFunds },
  }
}

/** A batch created on a local chain, in the terms a purchase reports. */
export interface LocalBatch {
  batchId: string
  depth: number
  /** Initial balance per chunk, in PLUR. */
  amountPerChunk: bigint
  /** Block the creation landed in, as the widget reports it (hex). */
  blockNumber: string
}

/**
 * Create a batch the account's postage signer OWNS, paid for by someone else —
 * the production role split, where the payment machinery creates the batch and
 * the derived signer owns it.
 *
 * Runs the widget's actual step list: swap → approve → createBatch → hand the
 * leftovers to the owner.
 */
export async function createOwnedBatchOnChain(
  derivationKey: string,
  requestedDepth?: number,
): Promise<LocalBatch> {
  const { destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain()
  // Any dev flow that makes a batch will go on to extend or resize it, so this
  // is the one place that guarantees the delegate is there for the bundled
  // path — including in e2e runs, which never start the solver.
  await ensureBundlingDelegate(chain.settings)
  const owner = destination as `0x${string}`
  const depth = requestedDepth ?? DEV_BATCH_DEPTH
  const { minimumInitialBalancePerChunk } = await chain.getPostageWriteConstraints()
  const amountPerChunk = minimumInitialBalancePerChunk * DEV_BATCH_FLOOR_MULTIPLE

  const created = await simulateWidgetPurchase(
    {
      owner,
      depth,
      amountPerChunk,
      payerPrivateKey: generatePrivateKey(),
      payerXdai: PURCHASE_PAYER_XDAI,
      swapXdai: PURCHASE_SWAP_XDAI,
    },
    chain.settings,
  )

  const receipt = await chain.getTransactionReceipt(created.transactionHash)
  return {
    batchId: created.batchId,
    depth,
    amountPerChunk,
    blockNumber: receipt?.blockNumber ?? '0x0',
  }
}

/**
 * Create a batch AND attach it to the account as a drive, in one go.
 *
 * Hand-testing extend or resize otherwise starts with six UI steps — create the
 * batch, copy its id, copy the signer key, paste both, import — every one of
 * which is a chance to paste the wrong field. The drive it leaves behind is an
 * ordinary one: a real batch the account's own signer owns.
 *
 * @returns the attached drive's batch id.
 */
export async function createTestDrive(account: Account): Promise<string> {
  const { batchId } = await createOwnedBatchOnChain(account.derivationKey)
  const { signerKey } = await derivePostageSigner(account.derivationKey)
  const stamp = await fetchExistingBatchFromChain(batchId, signerKey, '')
  if (!stamp) {
    throw new Error('The batch was created but could not be read back from the chain.')
  }
  account.addStamp(stamp)
  return batchId
}
