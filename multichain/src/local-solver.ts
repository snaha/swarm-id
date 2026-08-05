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
import { fundLocalAccount } from "./dev"
import { getChainId } from "./rpc"
import { type MultichainSettings, gnosisMainnetSettings } from "./settings"

/**
 * Where deposits are sent on the source chain — anvil's default account #9, so
 * they stay recoverable from the standard test mnemonic rather than burned.
 * Must match the app's `LOCAL_SOLVER_ADDRESS`.
 */
const SOLVER_ADDRESS = "0xa0ee7a142d267c1f36714e4a8f75612f20a79720"

const SOURCE_RPC_URL = process.env.SOURCE_RPC_URL ?? "http://localhost:8546"
const GNOSIS_RPC_URL = process.env.GNOSIS_RPC_URL ?? "http://localhost:9545"

const POLL_MS = 500

/**
 * A deliberate pause before filling. Instant delivery would hide every timeout,
 * cancel-mid-flight and resume bug the rehearsal exists to surface — and a real
 * cross-chain fill is seconds at best.
 */
const FILL_DELAY_MS = 3_000

/** Calldata layout: 20-byte recipient, then a 32-byte big-endian xDAI amount. */
const RECIPIENT_HEX_LENGTH = 40
const AMOUNT_HEX_LENGTH = 64
const INSTRUCTION_HEX_LENGTH = RECIPIENT_HEX_LENGTH + AMOUNT_HEX_LENGTH

interface DeliveryInstruction {
  recipient: `0x${string}`
  xdaiWei: bigint
}

/**
 * Read the delivery instruction a deposit carries.
 *
 * On-chain rather than through a side channel on purpose: it keeps the solver
 * stateless and means a deposit is self-describing, the way a real bridge
 * deposit carries its payload.
 *
 * @returns undefined when the calldata is not one of ours, so unrelated
 *   transfers to the same address are ignored rather than mis-delivered.
 */
export function decodeInstruction(
  input: string | undefined,
): DeliveryInstruction | undefined {
  const hex = (input ?? "").replace(/^0x/, "")
  if (hex.length !== INSTRUCTION_HEX_LENGTH) {
    return undefined
  }
  const recipient = `0x${hex.slice(0, RECIPIENT_HEX_LENGTH)}` as `0x${string}`
  const xdaiWei = BigInt(`0x${hex.slice(RECIPIENT_HEX_LENGTH)}`)
  return xdaiWei > 0n ? { recipient, xdaiWei } : undefined
}

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

async function sourceRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(SOURCE_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const data = (await response.json()) as {
    result?: unknown
    error?: { message?: string }
  }
  if (data.error) {
    throw new Error(data.error.message ?? `source chain rejected ${method}`)
  }
  return data.result
}

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
    if (transaction.to?.toLowerCase() !== SOLVER_ADDRESS) {
      return []
    }
    const instruction = decodeInstruction(transaction.input)
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
  console.log(`local solver: watching for deposits to ${SOLVER_ADDRESS}`)

  // Start at the head: replaying old deposits on restart would deliver twice
  // for payments that were already settled.
  let next = (await sourceBlockNumber()) + 1

  for (;;) {
    const head = await sourceBlockNumber()
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
    await sleep(POLL_MS)
  }
}

main().catch((error: unknown) => {
  console.error("local solver: fatal", error)
  process.exit(1)
})
