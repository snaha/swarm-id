// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * EIP-1193 event subscriptions that do not depend on the provider's
 * `removeListener`.
 *
 * Some providers cannot be unsubscribed from: `@web3-onboard/coinbase` replaces
 * `removeListener` with an empty function, so a handler attached per dialog
 * open would stay attached for the life of the page. Instead each provider gets
 * ONE real listener per event, installed on first use and never removed, which
 * dispatches to whichever handlers are currently subscribed. Unsubscribing only
 * edits that set, so it works whatever the provider does with `removeListener`.
 */
import type { EthereumProvider } from '$lib/payment/payment-rail'

type Handler = (payload: unknown) => void

const registries = new WeakMap<EthereumProvider, Map<string, Set<Handler>>>()

/**
 * Call `handler` for every `event` the provider emits until the returned
 * function is called. A provider with no `on` emits nothing, and the returned
 * function then does nothing.
 */
export function subscribeProviderEvent(
  provider: EthereumProvider,
  event: string,
  handler: Handler,
): () => void {
  if (!provider.on) {
    return () => undefined
  }
  let events = registries.get(provider)
  if (!events) {
    events = new Map()
    registries.set(provider, events)
  }
  let handlers = events.get(event)
  if (!handlers) {
    const installed = new Set<Handler>()
    handlers = installed
    events.set(event, installed)
    provider.on.call(provider, event, (payload) => {
      for (const current of [...installed]) {
        current(payload)
      }
    })
  }
  const subscribed = handlers
  subscribed.add(handler)
  return () => {
    subscribed.delete(handler)
  }
}
