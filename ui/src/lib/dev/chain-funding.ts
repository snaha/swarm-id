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

import { chainIdentity, ownerFunds, postageChain } from '$lib/payment/chain'
import { fetchExistingBatchFromChain } from '$lib/payment/contract'
import { derivePostageSigner } from '$lib/payment/purchase'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import type { Account } from '$lib/types'

/**
 * Anvil's first default account — the key every anvil prints on startup, so
 * publicly known and worth nothing off a dev chain.
 *
 * The dev chain is anvil, and anvil funds its ten default accounts at genesis
 * even when loading a state dump, so this address starts with 10 000 xDAI. It
 * holds no BZZ — that float is the bake's, and sits with `DEV_FAUCET_ADDRESS`.
 *
 * Importing it is never required; it is only the shortcut to a wallet showing
 * a balance from the start, instead of one that looks empty until the faucet
 * fills it.
 */
export const ANVIL_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
}

/** Default drive size for the dev batch actions. */
const DEV_BATCH_DEPTH = 20
/**
 * How long a dev batch is funded for, as a multiple of the contract's ~24h
 * minimum — so the number reads as days.
 *
 * The default clears the product's 7-day "Expires soon" threshold with room to
 * spare: a test drive that lands already flagged, under a "1 drive needs
 * attention" banner, trains everyone to read that warning as noise. The short
 * one is for deliberately producing that state.
 */
const DEV_BATCH_DAYS = 15n
/** A batch that is flagged the moment it exists, for testing the warning. */
const DEV_BATCH_EXPIRING_DAYS = 1n
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
 * Refuse to run anywhere but a chain that is provably a dev one.
 *
 * Nothing here can currently do damage on mainnet — the faucet key is public
 * and holds nothing, and no real node serves `anvil_setBalance` — but both of
 * those facts live two packages away, and neither was chosen as a safeguard.
 * The red banner warns the person; this stops the code. The banner has
 * normally probed this endpoint already, so it costs a map lookup.
 *
 * Takes the endpoint rather than reading it: every operation here pins one url
 * at entry and checks and spends against that same one. Re-reading the setting
 * per step let a switch mid-purchase send the spend to a chain this assertion
 * never saw.
 *
 * Asked positively on purpose: "not mainnet" waves through every other
 * reachable chain, and an unproven all-clear is exactly what spends real money.
 */
async function assertDevChain(tool: string, rpcUrl: string): Promise<void> {
  const { kind } = await chainIdentity(rpcUrl)
  if (kind !== 'dev') {
    const what = kind === 'mainnet' ? 'Gnosis mainnet' : 'a chain that is not Gnosis'
    throw new Error(`${tool} only runs on a dev chain — the configured Gnosis RPC serves ${what}.`)
  }
}

/** What one faucet send delivers. A zero leg is skipped entirely. */
export interface FaucetAmounts {
  /** Gnosis-side native xDAI, in wei. */
  xdai: bigint
  /** Gnosis-side BZZ, in PLUR. */
  bzzPlur: bigint
}

/**
 * Hand any address money on the dev chain.
 *
 * A transfer from the baked faucet rather than a trade: every swap moves a real
 * and thin BZZ pool, and topping an address up is not the thing worth
 * simulating faithfully. The purchase path still trades — see
 * `createOwnedBatchOnChain`.
 *
 * Any address, not just a derived signer: reproducing a bug usually means
 * funding the one address that is stuck.
 */
export async function sendFromFaucet(address: string, amounts: FaucetAmounts): Promise<void> {
  // Read once: the assertion and the transfer must be about the same chain.
  const rpcUrl = networkSettingsStore.gnosisRpcUrl
  const to = new EthAddress(address).toChecksum() as `0x${string}`
  // Nothing to send is a mistyped amount, not a send: reporting "✅ Sent 0" for
  // it reads as a transfer that happened.
  if (amounts.xdai <= 0n && amounts.bzzPlur <= 0n) {
    throw new Error('Enter an amount above zero.')
  }
  await assertDevChain('The faucet', rpcUrl)
  const chain = await postageChain(rpcUrl)
  await fundLocalAccount({ to, xdai: amounts.xdai, bzzPlur: amounts.bzzPlur }, chain.settings)
}

/** An address and what it holds on the Gnosis-side chain, for the faucet panel. */
export interface FundsRow {
  address: `0x${string}`
  xdai: bigint
  bzz: bigint
}

/** What the faucet has left to give, and what `address` holds. */
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

/** How long a created batch should last, and how big it should be. */
export interface BatchShape {
  depth?: number
  /** Days of lifespan to fund, as a multiple of the contract's ~24h floor. */
  days?: bigint
}

/**
 * Create a batch the account's postage signer OWNS, paid for by someone else —
 * the production role split, where the payment machinery creates the batch and
 * the derived signer owns it.
 *
 * Runs the widget's actual step list: swap → approve → createBatch → hand the
 * leftovers to the owner.
 *
 * @param rpcUrl — the endpoint every step of this purchase runs against;
 *   defaults to the current setting, and is passed in by a caller that has
 *   more to do on the same chain afterwards.
 */
export async function createOwnedBatchOnChain(
  derivationKey: string,
  { depth: requestedDepth, days = DEV_BATCH_DAYS }: BatchShape = {},
  rpcUrl: string = networkSettingsStore.gnosisRpcUrl,
): Promise<LocalBatch> {
  await assertDevChain('Creating a batch here', rpcUrl)
  const { destination } = await derivePostageSigner(derivationKey)
  const chain = await postageChain(rpcUrl)
  // Any dev flow that makes a batch will go on to extend or resize it, so this
  // is the one place that guarantees the delegate is there for the bundled
  // path — including in e2e runs, which never start the solver.
  await ensureBundlingDelegate(chain.settings)
  const owner = destination as `0x${string}`
  const depth = requestedDepth ?? DEV_BATCH_DEPTH
  const { minimumInitialBalancePerChunk } = await chain.getPostageWriteConstraints()
  const amountPerChunk = minimumInitialBalancePerChunk * days

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

/** How long to wait for the Bee node to catch up to the batch's block. */
const BATCH_VISIBLE_TIMEOUT_MS = 30_000
const BATCH_VISIBLE_POLL_MS = 500

/**
 * Wait until the Bee node has synced past the block the batch landed in.
 *
 * A batch bought straight from the contract exists on chain before the node
 * knows it: until Bee's chain sync reaches that block, stamping with it is
 * rejected with `400 invalid batch id`, so attaching the drive immediately
 * makes the very next account sync fail for no reason a reader can see.
 *
 * Best effort — a node that does not serve `/status` (a gateway) or one that
 * never catches up leaves the drive attached anyway, since the batch is real
 * either way and the next sync will retry.
 */
async function waitForNodeToSeeBatch(beeNodeUrl: string, blockNumber: string): Promise<void> {
  const target = Number(BigInt(blockNumber))
  if (!Number.isFinite(target) || target === 0) {
    return
  }
  const deadline = Date.now() + BATCH_VISIBLE_TIMEOUT_MS
  const statusUrl = new URL('status', beeNodeUrl.endsWith('/') ? beeNodeUrl : `${beeNodeUrl}/`)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl)
      if (!response.ok) {
        return
      }
      const { lastSyncedBlock } = (await response.json()) as { lastSyncedBlock?: number }
      if (lastSyncedBlock === undefined) {
        return
      }
      if (lastSyncedBlock >= target) {
        return
      }
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, BATCH_VISIBLE_POLL_MS))
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
 * @param shape — defaults to a drive that outlives the "Expires soon"
 *   threshold; pass `days: DEV_BATCH_EXPIRING_DAYS` to make one that does not.
 * @returns the attached drive's batch id.
 */
export async function createTestDrive(account: Account, shape?: BatchShape): Promise<string> {
  // Both endpoints read once, at the top: a purchase takes tens of seconds, and
  // an endpoint switch during it used to send the read-back to a chain the
  // batch was never bought on — reported as "could not be read back".
  const rpcUrl = networkSettingsStore.gnosisRpcUrl
  const beeNodeUrl = networkSettingsStore.beeNodeUrl
  const { batchId, blockNumber } = await createOwnedBatchOnChain(
    account.derivationKey,
    shape,
    rpcUrl,
  )
  const { signerKey } = await derivePostageSigner(account.derivationKey)
  const stamp = await fetchExistingBatchFromChain(batchId, signerKey, '', { rpcUrl })
  if (!stamp) {
    throw new Error('The batch was created but could not be read back from the chain.')
  }
  await waitForNodeToSeeBatch(beeNodeUrl, blockNumber)
  account.addStamp(stamp)
  return batchId
}

/** A drive that is already inside the "Expires soon" window, for testing it. */
export async function createExpiringTestDrive(account: Account): Promise<string> {
  return createTestDrive(account, { days: DEV_BATCH_EXPIRING_DAYS })
}
