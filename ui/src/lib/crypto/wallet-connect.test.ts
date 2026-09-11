// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { base, gnosis, mainnet } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PROJECT_ID, walletConnectOptions } from './wallet-connect'

const CHAINS = [mainnet, base, gnosis]
const ORIGIN = 'https://swarm-id.snaha.net'
const PROJECT_ID = 'f00ba4'

describe('walletConnectOptions', () => {
  // The guard that matters: `@web3-onboard/walletconnect` throws on a missing
  // project id, and it would throw while `onboard.ts` initialises — so a build
  // left with no id at all has to skip the module rather than pass it nothing.
  // Written against DEFAULT_PROJECT_ID rather than `undefined` so it keeps
  // testing the guard once a project is committed there.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('falls back to the committed default when the environment is %s', (_label, projectId) => {
    const options = walletConnectOptions(projectId, ORIGIN, CHAINS)

    expect(options?.projectId).toBe(DEFAULT_PROJECT_ID.trim() || undefined)
  })

  it('prefers the environment over the committed default', () => {
    expect(walletConnectOptions(PROJECT_ID, ORIGIN, CHAINS)?.projectId).toBe(PROJECT_ID)
  })

  it('offers every chain a payment may be signed on, and requires none', () => {
    const options = walletConnectOptions(PROJECT_ID, ORIGIN, CHAINS)

    expect(options?.optionalChains).toEqual([mainnet.id, base.id, gnosis.id])
    // Chains are offered, never required: a wallet that cannot serve a required
    // chain refuses the whole session.
    expect(options).not.toHaveProperty('requiredChains')
  })

  it('carries the project id and dapp url through', () => {
    expect(walletConnectOptions(`  ${PROJECT_ID}  `, ORIGIN, CHAINS)).toMatchObject({
      projectId: PROJECT_ID,
      dappUrl: ORIGIN,
    })
  })
})
