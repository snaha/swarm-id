// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // Optional override for the PostageStamp contract address used in on-chain
  // stamp-TTL reads. Unset in production (falls back to the mainnet default);
  // set to the local anvil deployment for development. See $lib/constants.
  interface ImportMetaEnv {
    readonly VITE_POSTAGE_STAMP_CONTRACT_ADDRESS?: string
  }
}

export {}
