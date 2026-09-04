// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineChain } from 'viem'
import { base } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { createWalletChainRecord } from './wallet-chain-record'

const OUR_GENESIS = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'

/** A chain the switch has to prove, the way the direct rail's Gnosis is. */
const gnosis = defineChain({
  id: 100,
  name: 'Gnosis Chain',
  nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.gnosischain.com'] } },
  custom: { genesisHash: OUR_GENESIS },
})
const chains = [gnosis, base]

/**
 * A wallet serving every chain it is asked for, answering the genesis probe
 * with `genesis` or refusing the question, and counting what it was asked.
 */
function wallet(
  options: {
    genesis?: string
    /** Runs while the switch is pending — where a wallet's own event lands. */
    onSwitch?: () => void
    declines?: boolean
  } = {},
) {
  const calls: string[] = []
  const provider = {
    request({ method }: { method: string; params?: unknown[] }) {
      calls.push(method)
      if (method === 'wallet_switchEthereumChain') {
        options.onSwitch?.()
        return options.declines
          ? Promise.reject({ code: 4001, message: 'User rejected the request.' })
          : Promise.resolve(undefined)
      }
      if (method === 'eth_getBlockByNumber') {
        return options.genesis === undefined
          ? Promise.reject(new Error('the method eth_getBlockByNumber does not exist'))
          : Promise.resolve({ hash: options.genesis })
      }
      return Promise.resolve(undefined)
    },
  }
  const count = (method: string) => calls.filter((call) => call === method).length
  return {
    provider,
    switches: () => count('wallet_switchEthereumChain'),
    probes: () => count('eth_getBlockByNumber'),
  }
}

describe('the wallet chain record', () => {
  it('asks the wallet once for a chain it was already put on', async () => {
    const { provider, switches, probes } = wallet({ genesis: OUR_GENESIS })
    const record = createWalletChainRecord()
    await record.ensure(provider, gnosis.id, chains)
    await record.ensure(provider, gnosis.id, chains)
    expect(switches()).toBe(1)
    expect(probes()).toBe(1)
  })

  it('asks again for a different chain', async () => {
    const { provider, switches } = wallet({ genesis: OUR_GENESIS })
    const record = createWalletChainRecord()
    await record.ensure(provider, gnosis.id, chains)
    await record.ensure(provider, base.id, chains)
    await record.ensure(provider, gnosis.id, chains)
    expect(switches()).toBe(3)
  })

  it('asks again once told to forget', async () => {
    const { provider, switches } = wallet({ genesis: OUR_GENESIS })
    const record = createWalletChainRecord()
    await record.ensure(provider, gnosis.id, chains)
    record.forget()
    await record.ensure(provider, gnosis.id, chains)
    expect(switches()).toBe(2)
  })

  it('records nothing from a switch the wallet declined', async () => {
    const { provider, switches } = wallet({ declines: true })
    const record = createWalletChainRecord()
    await expect(record.ensure(provider, gnosis.id, chains)).rejects.toMatchObject({ code: 4001 })
    await expect(record.ensure(provider, gnosis.id, chains)).rejects.toMatchObject({ code: 4001 })
    expect(switches()).toBe(2)
  })

  /**
   * Silence at the switch is not a mismatch (`switchWalletChain`), and it is
   * recorded like any accepted switch: proof is the rail's job right before it
   * signs, and asking a wallet that would not say to say again at Pay only
   * costs the probe's timeout a second time.
   */
  it('records a wallet that would not say, and leaves the proof to the rail', async () => {
    const { provider, probes } = wallet()
    const record = createWalletChainRecord()
    await record.ensure(provider, gnosis.id, chains)
    await record.ensure(provider, gnosis.id, chains)
    expect(probes()).toBe(1)
  })

  /**
   * A wallet announces the switch it was asked for while the request is still
   * pending — `chainChanged` lands before `wallet_switchEthereumChain` resolves
   * — and the dialog forgets on that event. The record is written once the
   * switch resolves and must outlive it, or a wallet that had to move (the
   * common case at connect) would never be recorded and Pay would prove the
   * chain again every time.
   */
  it('outlives a forget that lands while the switch is pending', async () => {
    const record = createWalletChainRecord()
    const { provider, switches } = wallet({
      genesis: OUR_GENESIS,
      onSwitch: () => record.forget(),
    })
    await record.ensure(provider, gnosis.id, chains)
    await record.ensure(provider, gnosis.id, chains)
    expect(switches()).toBe(1)
  })
})
