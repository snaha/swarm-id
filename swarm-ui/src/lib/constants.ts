// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Optional override for the PostageStamp contract address used in on-chain
// stamp-expiry (TTL) reads. `undefined` when the env var is unset — the lib's
// TTL functions then apply their Gnosis mainnet default, so the app never needs
// to know the mainnet address itself. Production builds set nothing and get
// mainnet; local development against the bee-compose anvil chain sets
// VITE_POSTAGE_STAMP_CONTRACT_ADDRESS inline in the dev script (see package.json
// `dev:swarm-ui`) and must also point the Gnosis RPC URL at the local node
// (http://localhost:9545) via the identity UI's network settings.
export const postageStampContractAddress = import.meta.env.VITE_POSTAGE_STAMP_CONTRACT_ADDRESS
