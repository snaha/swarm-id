// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * When a passkey / wallet prompt counts as open. A caller that stays mounted
 * past the unlock renders off `pending`, so it has to end with the ceremony.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Account } from '$lib/types'

import { createUnlockCeremony } from './unlock-ceremony.svelte'

const crypto = vi.hoisted(() => ({ unlockAccount: vi.fn() }))
vi.mock('$lib/crypto/unlock', () => crypto)

const passkeyAccount = {
  accessMethod: { type: 'passkey' },
  signedOutAt: undefined,
} as unknown as Account

const ENTROPY = new Uint8Array([1, 2, 3])

beforeEach(() => {
  crypto.unlockAccount.mockReset()
})

describe('createUnlockCeremony', () => {
  it('keeps the prompt up through the unlocked step, then closes it', async () => {
    crypto.unlockAccount.mockResolvedValue(ENTROPY)
    let pendingDuringStep: boolean | undefined
    const ceremony = createUnlockCeremony(passkeyAccount, () => {
      pendingDuringStep = ceremony.pending
    })

    await ceremony.confirm('')

    expect(pendingDuringStep).toBe(true)
    expect(ceremony.pending).toBe(false)
    expect(ceremony.busy).toBe(false)
  })

  it('closes the prompt when the unlock fails, and says why', async () => {
    crypto.unlockAccount.mockRejectedValue(new Error('Passkey refused'))
    const ceremony = createUnlockCeremony(passkeyAccount, vi.fn())

    await ceremony.confirm('')

    expect(ceremony.pending).toBe(false)
    expect(ceremony.error).toBe('Passkey refused')
  })

  it('leaves a cancelled ceremony to whoever cancelled it', async () => {
    let approve: (entropy: Uint8Array) => void = () => undefined
    crypto.unlockAccount.mockReturnValue(new Promise((resolve) => (approve = resolve)))
    const onunlocked = vi.fn()
    const ceremony = createUnlockCeremony(passkeyAccount, onunlocked)

    const confirming = ceremony.confirm('')
    ceremony.cancel()
    approve(ENTROPY.slice())
    await confirming

    expect(onunlocked).not.toHaveBeenCalled()
  })
})
