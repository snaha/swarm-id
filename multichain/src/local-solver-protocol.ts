// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * LOCAL DEV / TEST ONLY — the wire format between a rehearsed payment and the
 * local solver that fills it.
 *
 * The app deposits on the source chain and the solver pays out on the Gnosis
 * chain; this module is the only thing they share. It lives here, in one place
 * and with no dependencies, because the two ends are in different packages —
 * and a format agreed in two places is a format that drifts. Encoder and
 * decoder are tested against each other, not against a restatement.
 *
 * A deposit carries its own delivery instruction in calldata:
 *
 *   bytes  0..20  recipient address on the Gnosis-side chain
 *   bytes 20..52  xDAI to deliver, uint256 big-endian
 *
 * On-chain rather than through a side channel, so the deposit is
 * self-describing and the solver can stay stateless — the way a real bridge
 * deposit carries its payload.
 */

/**
 * Where deposits are sent on the source chain: anvil's default account #9, so
 * they stay recoverable from the standard test mnemonic rather than burned.
 * Lower-cased because it is compared against `to` fields straight off the RPC.
 */
export const LOCAL_SOLVER_ADDRESS = "0xa0ee7a142d267c1f36714e4a8f75612f20a79720"

const RECIPIENT_HEX_LENGTH = 40
const AMOUNT_HEX_LENGTH = 64
const INSTRUCTION_HEX_LENGTH = RECIPIENT_HEX_LENGTH + AMOUNT_HEX_LENGTH

export interface DeliveryInstruction {
  /** Address the xDAI must reach on the Gnosis-side chain. */
  recipient: `0x${string}`
  /** Exact xDAI, in wei. */
  xdaiWei: bigint
}

/** Render an instruction as the calldata a deposit carries. */
export function encodeDeliveryInstruction(
  instruction: DeliveryInstruction,
): `0x${string}` {
  const recipient = instruction.recipient
    .replace(/^0x/, "")
    .toLowerCase()
    .padStart(RECIPIENT_HEX_LENGTH, "0")
  const amount = instruction.xdaiWei
    .toString(16)
    .padStart(AMOUNT_HEX_LENGTH, "0")
  return `0x${recipient}${amount}`
}

/**
 * Read the instruction a deposit carries.
 *
 * @returns undefined when the calldata is not one of ours, so an unrelated
 *   transfer to the solver address is ignored rather than mis-delivered — and
 *   for a zero amount, which would be a fill that costs a transaction and
 *   delivers nothing while still reading as a settled payment.
 */
export function decodeDeliveryInstruction(
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
