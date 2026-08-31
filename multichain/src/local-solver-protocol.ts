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
 * and, when the payment is made in an ERC-20 rather than the native token,
 * two more fields naming what the solver must pull from the payer first —
 * the deposit itself then carries no value, only the instruction:
 *
 *   bytes 52..72  source-chain token to pull
 *   bytes 72..104 token amount to pull, uint256 big-endian
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

/**
 * Where the mock USDC lives on the source chain: mainnet USDC's own address,
 * mirroring the real chain the way the Gnosis-side chain carries its contracts
 * at mainnet addresses. The solver installs the code there at startup.
 */
export const LOCAL_SOURCE_USDC_ADDRESS =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

const RECIPIENT_HEX_LENGTH = 40
const AMOUNT_HEX_LENGTH = 64
const INSTRUCTION_HEX_LENGTH = RECIPIENT_HEX_LENGTH + AMOUNT_HEX_LENGTH
const PULL_INSTRUCTION_HEX_LENGTH =
  INSTRUCTION_HEX_LENGTH + RECIPIENT_HEX_LENGTH + AMOUNT_HEX_LENGTH

export interface DeliveryInstruction {
  /** Address the xDAI must reach on the Gnosis-side chain. */
  recipient: `0x${string}`
  /** Exact xDAI, in wei. */
  xdaiWei: bigint
  /**
   * The ERC-20 payment the solver must collect from the payer before filling,
   * against the allowance the payer's approve granted it. Absent for a native
   * payment, where the deposit's own value is the collection.
   */
  pull?: {
    /** Source-chain token the payer approved. */
    token: `0x${string}`
    /** Amount to pull, in the token's own base units. */
    amountWei: bigint
  }
}

const address = (value: string): string =>
  value.replace(/^0x/, "").toLowerCase().padStart(RECIPIENT_HEX_LENGTH, "0")

const amount = (value: bigint): string =>
  value.toString(16).padStart(AMOUNT_HEX_LENGTH, "0")

/** Render an instruction as the calldata a deposit carries. */
export function encodeDeliveryInstruction(
  instruction: DeliveryInstruction,
): `0x${string}` {
  const base = `${address(instruction.recipient)}${amount(instruction.xdaiWei)}`
  const pull = instruction.pull
  return pull
    ? `0x${base}${address(pull.token)}${amount(pull.amountWei)}`
    : `0x${base}`
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
  if (
    hex.length !== INSTRUCTION_HEX_LENGTH &&
    hex.length !== PULL_INSTRUCTION_HEX_LENGTH
  ) {
    return undefined
  }
  const recipient = `0x${hex.slice(0, RECIPIENT_HEX_LENGTH)}` as `0x${string}`
  const xdaiWei = BigInt(
    `0x${hex.slice(RECIPIENT_HEX_LENGTH, INSTRUCTION_HEX_LENGTH)}`,
  )
  if (xdaiWei === 0n) {
    return undefined
  }
  if (hex.length === INSTRUCTION_HEX_LENGTH) {
    return { recipient, xdaiWei }
  }
  const token = `0x${hex.slice(
    INSTRUCTION_HEX_LENGTH,
    INSTRUCTION_HEX_LENGTH + RECIPIENT_HEX_LENGTH,
  )}` as `0x${string}`
  const amountWei = BigInt(
    `0x${hex.slice(INSTRUCTION_HEX_LENGTH + RECIPIENT_HEX_LENGTH)}`,
  )
  // A zero pull is the token-side twin of the zero amount above: an approve
  // and a fill that move nothing while still reading as a settled payment.
  return amountWei > 0n
    ? { recipient, xdaiWei, pull: { token, amountWei } }
    : undefined
}
