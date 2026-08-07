// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * LOCAL DEV / TEST ONLY — the solver that stands in for Relay.
 *
 * Relay is an intent/solver network: the user's wallet deposits on the source
 * chain, and an off-chain solver watching that chain delivers on the
 * destination chain out of its own inventory. None of it can see a local chain,
 * so locally this process plays the solver — the one part of the arrangement
 * that is genuinely off-chain, and so the one part a local chain can host
 * honestly.
 *
 * It watches the source chain for deposits to the solver address, reads the
 * delivery instruction out of each deposit's calldata, and pays the recipient
 * from the Gnosis-side chain's faucet.
 *
 * Running it as a service rather than doing the transfer in the browser is what
 * makes the app's side of the rehearsal faithful: the app signs and then WAITS
 * for money it does not control to arrive, exactly as it waits on Relay. With
 * this process stopped, a payment hangs and times out — which is what a solver
 * outage looks like.
 *
 * Never import this from production code.
 */

import { RollingValueProvider } from "cafe-utility"
import { ensureBundlingDelegate, fundLocalAccount } from "./dev"
import { devRpc } from "./dev-rpc"
import {
  type DeliveryInstruction,
  LOCAL_SOLVER_ADDRESS,
  decodeDeliveryInstruction,
} from "./local-solver-protocol"
import { getChainId } from "./rpc"
import { type MultichainSettings, gnosisMainnetSettings } from "./settings"

const SOURCE_RPC_URL = process.env.SOURCE_RPC_URL ?? "http://localhost:8545"
const GNOSIS_RPC_URL = process.env.GNOSIS_RPC_URL ?? "http://localhost:9545"

const POLL_MS = 500

/**
 * A deliberate pause before filling. Instant delivery would hide every timeout,
 * cancel-mid-flight and resume bug the rehearsal exists to surface — and a real
 * cross-chain fill is seconds at best.
 */
const FILL_DELAY_MS = 3_000

interface SourceTransaction {
  hash: string
  to: string | null
  input?: string
}

interface SourceBlock {
  transactions: SourceTransaction[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const sourceRpc = (method: string, params: unknown[]): Promise<unknown> =>
  devRpc(SOURCE_RPC_URL, method, params)

/** The source chain's head. Its own endpoint — this is not the Gnosis chain. */
async function sourceBlockNumber(): Promise<number> {
  return Number(BigInt(String(await sourceRpc("eth_blockNumber", []))))
}

/** Deposits addressed to the solver in one block, oldest first. */
async function depositsIn(
  blockNumber: number,
): Promise<Array<{ hash: string; instruction: DeliveryInstruction }>> {
  const block = (await sourceRpc("eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    true,
  ])) as SourceBlock | null
  if (!block) {
    return []
  }
  return block.transactions.flatMap((transaction) => {
    if (transaction.to?.toLowerCase() !== LOCAL_SOLVER_ADDRESS) {
      return []
    }
    const instruction = decodeDeliveryInstruction(transaction.input)
    return instruction ? [{ hash: transaction.hash, instruction }] : []
  })
}

async function fill(
  instruction: DeliveryInstruction,
  settings: MultichainSettings,
): Promise<void> {
  await sleep(FILL_DELAY_MS)
  await fundLocalAccount(
    { to: instruction.recipient, xdai: instruction.xdaiWei, bzzPlur: 0n },
    settings,
  )
}

async function main(): Promise<void> {
  const settings = gnosisMainnetSettings({ rpcUrls: [GNOSIS_RPC_URL] })
  const gnosisProvider = new RollingValueProvider(settings.rpcUrls)

  // Fail loudly and immediately rather than sitting silently on a dead port:
  // a solver that looks alive but sees nothing is the most confusing possible
  // state for whoever is trying to rehearse a payment.
  const gnosisChainId = await getChainId(settings, gnosisProvider)
  await sourceRpc("eth_chainId", [])
  console.log(
    `local solver: source ${SOURCE_RPC_URL} -> gnosis ${GNOSIS_RPC_URL} (chain ${gnosisChainId})`,
  )
  // The chain is up and ours, so make sure the postage bundle can run on it —
  // the baked snapshot cannot carry the 7702 delegate.
  await ensureBundlingDelegate(settings)

  console.log(`local solver: watching for deposits to ${LOCAL_SOLVER_ADDRESS}`)

  // Start at the head: replaying old deposits on restart would deliver twice
  // for payments that were already settled.
  let next = (await sourceBlockNumber()) + 1

  for (;;) {
    try {
      const head = await sourceBlockNumber()
      // A restarted anvil begins from block 0 again, leaving the pointer above
      // the new head — where it stays forever, because the head never climbs
      // back to meet it. The solver then looks perfectly healthy and ignores
      // every deposit: the same "silently strand every later payment" state the
      // catch below exists to prevent, reached through a different door, and
      // the one surviving a restart would otherwise land in.
      if (head + 1 < next) {
        console.log(
          `local solver: source chain restarted (head ${head}, expected ${next}) — resuming from its head`,
        )
        next = head + 1
      }
      while (next <= head) {
        for (const deposit of await depositsIn(next)) {
          const { recipient, xdaiWei } = deposit.instruction
          console.log(
            `local solver: deposit ${deposit.hash} -> delivering ${xdaiWei} wei xDAI to ${recipient}`,
          )
          try {
            await fill(deposit.instruction, settings)
            console.log(`local solver: delivered to ${recipient}`)
          } catch (error) {
            // Keep watching: one failed fill must not take the solver down and
            // silently strand every later payment.
            console.error(`local solver: delivery failed`, error)
          }
        }
        next += 1
      }
    } catch (error) {
      // Same rule, one level up. Reading the source chain is just as fallible
      // as filling — a restarted anvil, a container that has not come back yet,
      // a blip under load — and an exit here is worse than a failed fill,
      // because it strands EVERY later payment behind a delivery timeout whose
      // message points at a solver that is no longer running to be blamed.
      // `next` is not advanced, so nothing is skipped once the chain returns.
      console.error(`local solver: source chain read failed, retrying`, error)
    }
    await sleep(POLL_MS)
  }
}

main().catch((error: unknown) => {
  console.error("local solver: fatal", error)
  process.exit(1)
})
