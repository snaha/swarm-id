// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * EIP-1193 subscriptions that never call `removeListener`, which
 * `@web3-onboard/coinbase` stubs out: one real listener per provider and event,
 * dispatching to the handlers currently subscribed.
 */
import type { EthereumProvider } from '$lib/payment/payment-rail'

type Handler = (payload: unknown) => void

const registries = new WeakMap<EthereumProvider, Map<string, Set<Handler>>>()

/** Subscribe `handler` to `event`; call the result to unsubscribe. */
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
