// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chainIdentity, postageChain, probeChainId } from './chain'

/** The real one. A chain cannot borrow it, which is the whole point. */
const GNOSIS_GENESIS = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'
const DEV_GENESIS = '0x' + '11'.repeat(32)
const GNOSIS_CHAIN_ID_HEX = '0x64'

/**
 * The module caches one probe per RPC URL for the life of the process, on
 * purpose: the chain a URL serves does not change under us. There is therefore
 * nothing to reset between tests, so each one names its own endpoint.
 */
let endpointCount = 0
function freshUrl(): string {
  endpointCount += 1
  return `http://chain-test-${endpointCount}.invalid`
}

interface RpcAnswer {
  result?: unknown
  error?: { message: string }
  /** Defaults to 200. */
  status?: number
}

/**
 * Answer JSON-RPC calls by method, so a test can break exactly one of them.
 * @returns the stub, for counting calls.
 */
function stubRpc(answers: Record<string, RpcAnswer>) {
  const stub = vi.fn((_url: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string }
    const answer = answers[method] ?? { status: 501 }
    const status = answer.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, ...answer }),
    })
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

const mainnetAnswers: Record<string, RpcAnswer> = {
  eth_chainId: { result: GNOSIS_CHAIN_ID_HEX },
  eth_getBlockByNumber: { result: { hash: GNOSIS_GENESIS } },
}

const devChainAnswers: Record<string, RpcAnswer> = {
  eth_chainId: { result: GNOSIS_CHAIN_ID_HEX },
  eth_getBlockByNumber: { result: { hash: DEV_GENESIS } },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('probeChainId', () => {
  it('reads the hex chain id as a number', async () => {
    stubRpc(mainnetAnswers)
    await expect(probeChainId(freshUrl())).resolves.toBe(100)
  })
})

describe('chainIdentity', () => {
  it('calls the real genesis mainnet', async () => {
    stubRpc(mainnetAnswers)
    await expect(chainIdentity(freshUrl())).resolves.toEqual({ chainId: 100, kind: 'mainnet' })
  })

  it('calls a chain wearing id 100 with another genesis a dev chain', async () => {
    stubRpc(devChainAnswers)
    await expect(chainIdentity(freshUrl())).resolves.toEqual({ chainId: 100, kind: 'dev' })
  })

  // The same invariant from the other side: a reachable chain that is not
  // Gnosis at all is neither of the two known answers, and must not be handed
  // the dev one — pointed at Ethereum, "not mainnet" would invite the faucet
  // to spend there.
  it.each([
    ['its own genesis', { hash: '0x' + '22'.repeat(32) }],
    ['a genesis that matches Gnosis', { hash: GNOSIS_GENESIS }],
  ])('calls a chain that is not Gnosis unsupported, whatever %s says', async (_label, block) => {
    stubRpc({ eth_chainId: { result: '0x1' }, eth_getBlockByNumber: { result: block } })
    await expect(chainIdentity(freshUrl())).resolves.toEqual({ chainId: 1, kind: 'unsupported' })
  })

  // The invariant the whole module exists for: "we could not prove it" must
  // never come out as a dev chain, which is the answer that tells the page
  // spending is free.
  it.each([
    ['a JSON-RPC error', { error: { message: 'pruned' } }],
    ['a non-2xx status', { status: 429 }],
    ['no result at all', {}],
    // JSON-RPC's own "no such block": a pruned node answers with an explicit
    // null rather than by omitting the field.
    ['a null result', { result: null }],
    ['a block with no hash', { result: {} }],
  ])('rejects when the genesis probe answers %s', async (_label, answer: RpcAnswer) => {
    stubRpc({ ...mainnetAnswers, eth_getBlockByNumber: answer })
    // The module's own wording, not just any rejection: a null result read as an
    // answer still rejects — with a TypeError from dereferencing it — and that
    // is the failure this asserts is gone.
    await expect(chainIdentity(freshUrl())).rejects.toThrow(/configured Gnosis RPC/)
  })

  it('rejects when the chain id itself cannot be read', async () => {
    stubRpc({ ...mainnetAnswers, eth_chainId: { error: { message: 'rate limited' } } })
    await expect(chainIdentity(freshUrl())).rejects.toThrow()
  })

  it('does not cache a failure — the node may just have been starting up', async () => {
    const url = freshUrl()
    stubRpc({ eth_chainId: { status: 502 }, eth_getBlockByNumber: { status: 502 } })
    await expect(chainIdentity(url)).rejects.toThrow()

    stubRpc(mainnetAnswers)
    await expect(chainIdentity(url)).resolves.toEqual({ chainId: 100, kind: 'mainnet' })
  })
})

describe('postageChain', () => {
  it('gives a dev chain no public fallbacks — one would read REAL mainnet state', async () => {
    stubRpc(devChainAnswers)
    const url = freshUrl()
    const chain = await postageChain(url)
    expect(chain.settings.rpcUrls).toEqual([url])
  })

  it('keeps the public fallbacks behind the configured endpoint on mainnet', async () => {
    stubRpc(mainnetAnswers)
    const url = freshUrl()
    const chain = await postageChain(url)
    expect(chain.settings.rpcUrls[0]).toBe(url)
    expect(chain.settings.rpcUrls.length).toBeGreaterThan(1)
  })

  it('refuses a chain that is not Gnosis at all', async () => {
    stubRpc({ ...mainnetAnswers, eth_chainId: { result: '0x1' } })
    await expect(postageChain(freshUrl())).rejects.toThrow(/not Gnosis/)
  })

  it('serves the same client for the same endpoint, probing once', async () => {
    const rpc = stubRpc(devChainAnswers)
    const url = freshUrl()
    const [first, second] = await Promise.all([postageChain(url), postageChain(url)])
    expect(first).toBe(second)
    expect(rpc).toHaveBeenCalledTimes(2) // chain id + genesis, once between them
  })
})
