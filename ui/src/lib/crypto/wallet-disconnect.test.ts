// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { TimeoutError } from '@snaha/swarm-id'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { disconnectWallet } from './wallet-disconnect'

const WALLET_CONNECT_LABEL = 'WalletConnect'
const INJECTED_LABEL = 'MetaMask'
const COINBASE_LABEL = 'Coinbase Wallet'
const TIMEOUT_MS = 5_000
const SESSION_TOPIC = 'f00ba4'

// A promise settled manually by the test — the relay acknowledging, or not, the
// end of a WalletConnect session.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Lets every queued microtask run, so a promise that can settle has. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve))
}

interface FakeProvider {
  disconnect?(): void
}

interface FakeWallet {
  label: string
  provider: FakeProvider
}

/**
 * `@web3-onboard/core` without wagmi: hands the label to the wallet module's
 * teardown without awaiting it, drops the wallet from state, and returns.
 */
function fakeOnboard(wallets: FakeWallet[]) {
  let held = wallets
  return {
    state: { get: () => ({ wallets: held }) },
    disconnectWallet: vi.fn(async ({ label }: { label: string }) => {
      held.find((wallet) => wallet.label === label)?.provider.disconnect?.()
      held = held.filter((wallet) => wallet.label !== label)
      return held
    }),
  }
}

/**
 * `@web3-onboard/walletconnect`'s provider wrapper around an EthereumProvider
 * (`connector`), whose session is gone only once the relay has acknowledged
 * the disconnect — when `ended` resolves.
 */
function walletConnectWallet() {
  const ended = deferred<void>()
  const connector = {
    session: { topic: SESSION_TOPIC } as { topic: string } | undefined,
    disconnect: vi.fn(async () => {
      await ended.promise
      connector.session = undefined
    }),
  }
  const provider = {
    connector,
    disconnect() {
      if (connector.session) {
        void connector.disconnect()
      }
    },
  }
  return { wallet: { label: WALLET_CONNECT_LABEL, provider }, connector, ended }
}

describe('disconnectWallet', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds until a WalletConnect session has ended', async () => {
    const { wallet, ended } = walletConnectWallet()
    const onboard = fakeOnboard([wallet])
    let settled = false

    const done = disconnectWallet(onboard, WALLET_CONNECT_LABEL, TIMEOUT_MS).then(() => {
      settled = true
    })
    await flushMicrotasks()

    expect(settled).toBe(false)
    ended.resolve()
    await done
    expect(onboard.disconnectWallet).toHaveBeenCalledWith({ label: WALLET_CONNECT_LABEL })
    expect(onboard.state.get().wallets).toEqual([])
  })

  it('ends the session once, not again through onboard', async () => {
    const { wallet, connector, ended } = walletConnectWallet()
    const onboard = fakeOnboard([wallet])

    const done = disconnectWallet(onboard, WALLET_CONNECT_LABEL, TIMEOUT_MS)
    ended.resolve()
    await done

    expect(connector.disconnect).toHaveBeenCalledTimes(1)
  })

  it('gives up at the deadline, and onboard still forgets the wallet', async () => {
    vi.useFakeTimers()
    const { wallet } = walletConnectWallet()
    const onboard = fakeOnboard([wallet])

    const done = disconnectWallet(onboard, WALLET_CONNECT_LABEL, TIMEOUT_MS)
    const rejected = expect(done).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await rejected

    // Onboard's picker hands back a wallet it still holds, dying session and all.
    expect(onboard.disconnectWallet).toHaveBeenCalledWith({ label: WALLET_CONNECT_LABEL })
    expect(onboard.state.get().wallets).toEqual([])
  })

  it('rejects with a failed teardown, and onboard still forgets the wallet', async () => {
    const { wallet, connector } = walletConnectWallet()
    const failure = new Error('relay unreachable')
    connector.disconnect.mockRejectedValueOnce(failure)
    const onboard = fakeOnboard([wallet])

    await expect(disconnectWallet(onboard, WALLET_CONNECT_LABEL, TIMEOUT_MS)).rejects.toBe(failure)

    expect(onboard.disconnectWallet).toHaveBeenCalledWith({ label: WALLET_CONNECT_LABEL })
    expect(onboard.state.get().wallets).toEqual([])
  })

  it.each([
    ['an injected wallet', { label: INJECTED_LABEL, provider: {} }],
    ['Coinbase Wallet', { label: COINBASE_LABEL, provider: { disconnect: vi.fn() } }],
  ])('just drops %s, which has no remote session to end', async (_name, wallet) => {
    const onboard = fakeOnboard([wallet])
    let settled = false

    const done = disconnectWallet(onboard, wallet.label, TIMEOUT_MS).then(() => {
      settled = true
    })
    await flushMicrotasks()

    expect(settled).toBe(true)
    await done
    expect(onboard.disconnectWallet).toHaveBeenCalledWith({ label: wallet.label })
    expect(onboard.state.get().wallets).toEqual([])
  })

  it('still tells onboard about a wallet it does not hold', async () => {
    const onboard = fakeOnboard([])

    await expect(
      disconnectWallet(onboard, WALLET_CONNECT_LABEL, TIMEOUT_MS),
    ).resolves.toBeUndefined()

    expect(onboard.disconnectWallet).toHaveBeenCalledWith({ label: WALLET_CONNECT_LABEL })
  })
})
