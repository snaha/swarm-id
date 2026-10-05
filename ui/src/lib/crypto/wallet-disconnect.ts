// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Onboard's `disconnectWallet` drops the wallet from its state at once and
 * leaves the wallet module's teardown running unawaited, so it resolves before
 * the wallet has let go. For WalletConnect that teardown is remote: the session
 * leaves storage only once the relay acknowledges its end, and a provider
 * created before then restores it from storage and connects without asking.
 * `@web3-onboard/walletconnect` keeps that provider as `connector` on the one it
 * hands out, and its own `disconnect` drops the promise — so the session is
 * ended here, through `connector`, where the promise can be awaited.
 */
import { withTimeout } from '@snaha/swarm-id'

/** The part of an Onboard instance a disconnect needs. */
interface WalletRegistry {
  state: { get(): { wallets: readonly { label: string; provider: unknown }[] } }
  disconnectWallet(options: { label: string }): Promise<unknown>
}

/** `@web3-onboard/walletconnect`'s provider, holding the WalletConnect EthereumProvider. */
interface WalletConnectProvider {
  connector: { disconnect(): Promise<void> }
}

function isWalletConnectProvider(provider: unknown): provider is WalletConnectProvider {
  const candidate = provider as WalletConnectProvider | undefined
  return typeof candidate?.connector?.disconnect === 'function'
}

/**
 * Disconnect a wallet, resolving once any remote session it holds has ended.
 *
 * Onboard forgets the wallet whatever happens — on a timeout or a failed
 * teardown too — because its picker hands back a wallet it still holds, old
 * session and all. Ending the session first leaves onboard's own teardown
 * nothing to end.
 *
 * @throws {TimeoutError} when the session has not ended within `timeoutMs`.
 */
export async function disconnectWallet(
  onboard: WalletRegistry,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const provider = onboard.state.get().wallets.find((wallet) => wallet.label === label)?.provider
  try {
    if (isWalletConnectProvider(provider)) {
      await withTimeout(provider.connector.disconnect(), timeoutMs, 'Wallet disconnect timed out')
    }
  } finally {
    await onboard.disconnectWallet({ label })
  }
}
