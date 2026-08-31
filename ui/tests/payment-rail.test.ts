// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The payment screens, driven end to end against the dev rail.
 *
 * Every other drive suite pins the rail OFF, so funding falls back to a silent
 * faucet transfer and these screens never open. That left the whole
 * method → connect → configure → pay path — and everything the payment hands
 * off to — covered by hand only. This is the suite that exercises it.
 *
 * What is real here: the wallet signs a genuine deposit on the local source
 * chain, a separate solver process sees it and delivers xDAI on the Gnosis-side
 * chain, that xDAI is swapped for BZZ through the real SushiSwap pool, and the
 * batch is created on the real PostageStamp contract. The assertion at the end
 * is that the batch exists on chain and the account's own derived signer owns
 * it — so the money the wallet paid really did become storage.
 *
 * What is NOT covered, and must not be read as covered: Relay itself. Its
 * pricing, routing and refund semantics are a hosted service this cannot
 * reach — the local rail mirrors only the step shape, one signature for a
 * native payment and approve-then-deposit for a token one. A green run here
 * means the orchestration is right, not that the production rail works.
 *
 * Needs `pnpm dev:local` — both chains AND the solver. The chains are probed
 * and the suite skips without them; a stopped solver cannot be probed, so it
 * surfaces as the rail's own "taken but never delivered" error instead.
 */
import { PrivateKey } from '@ethersphere/bee-js'
import { type Page, expect, test } from '@playwright/test'

import { CHAIN_RPC_URL, addDrive, chainReachable, completeCreateFlow } from './helpers'

/** Where `pnpm dev:source-chain` listens, and the id it reports. */
const SOURCE_RPC_URL = process.env.SOURCE_RPC_URL ?? 'http://localhost:31337'
const SOURCE_CHAIN_ID = 31337
/** The destination chain, which is also a source you can pay from directly. */
const GNOSIS_CHAIN_ID = 100
const BEE_NODE_URL = 'http://localhost:1633/'

/** Deposit → solver fill → swap → createBatch spans a lot of chain time. */
const PAYMENT_TIMEOUT_MS = 180_000

/** Anvil's first prefunded account — the "wallet" the injected provider is. */
const WALLET_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** `local-solver-protocol.ts` — deposits are addressed here. */
const LOCAL_SOLVER_ADDRESS = '0xa0ee7a142d267c1f36714e4a8f75612f20a79720'

/** PostageStamp on Gnosis, which the local chain carries at the same address. */
const GNOSIS_POSTAGE_STAMP = '0x45a1502382541Cd610CC9068e88727426b696293'
/** `batches(bytes32)`; the owner is the first word of the return. */
const BATCHES_SELECTOR = '0xc81e25ab'
const ZERO_ADDRESS_WORD = '0'.repeat(64)

const PROBE_TIMEOUT_MS = 2000

async function sourceChainReachable(): Promise<boolean> {
  try {
    const response = await fetch(SOURCE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const { result } = (await response.json()) as { result?: string }
    return typeof result === 'string' && Number(BigInt(result)) === SOURCE_CHAIN_ID
  } catch {
    return false
  }
}

const chainUp = await chainReachable()
const sourceUp = await sourceChainReachable()
test.skip(!chainUp || !sourceUp, 'requires both chains and the solver (pnpm dev:local)')

/**
 * An injected wallet that actually pays.
 *
 * The trick is that it needs no key and no signing: anvil keeps its dev
 * accounts unlocked, so forwarding `eth_sendTransaction` to the source chain
 * produces a real, mined transaction from a real account. Everything the
 * provider does not answer locally is proxied, so the flow talks to a chain
 * rather than to a fixture.
 *
 * It starts on Ethereum mainnet deliberately: the payment screen selects the
 * source chain, so `pay()` has to negotiate a network switch first, and that
 * is a state the designs draw and the code has a branch for.
 */
async function injectPayingWallet(page: Page, { misroutedGnosis = false } = {}) {
  await page.addInitScript(
    ([sourceRpc, gnosisRpc, address, sourceChainId, gnosisChainId, misrouted]) => {
      const sourceHex = `0x${Number(sourceChainId).toString(16)}`
      const gnosisHex = `0x${Number(gnosisChainId).toString(16)}`
      // Both chains a wallet can be asked to pay from: the destination itself
      // (no bridge) and the stand-in source (bridged). Keyed by the id the app
      // asks to switch to, so the deposit lands on the chain it names.
      const endpoints: Record<string, string> = {
        [sourceHex]: sourceRpc as string,
        // Misrouted plays the wallet a user actually has: chain 100 already
        // configured, but its ACTIVE endpoint is another network entirely —
        // what having the real Gnosis selected looks like to this app.
        [gnosisHex]: misrouted ? (sourceRpc as string) : (gnosisRpc as string),
      }
      let chainId = '0x1'
      // A wallet that has never seen these chains, which is every wallet the
      // first time. Until one is added, switching to it fails with 4902 — the
      // branch that drives `wallet_addEthereumChain`, and the one a fake that
      // silently accepts the switch never reaches. A misrouted wallet already
      // knows chain 100 — that is the whole trap.
      const added = new Set<string>(misrouted ? [gnosisHex] : [])
      const listeners: Array<(value: unknown) => void> = []
      // Signature count, for asserting HOW MANY times the flow asked the user
      // to sign — one deposit for a native payment, approve + deposit for a
      // token one.
      let sends = 0
      Object.defineProperty(window, '__walletSends', { get: () => sends })

      async function rpc(method: string, params: unknown[]) {
        const response = await fetch(endpoints[chainId] ?? (sourceRpc as string), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        })
        const body = (await response.json()) as { result?: unknown; error?: { message: string } }
        if (body.error) {
          throw new Error(body.error.message)
        }
        return body.result
      }

      const provider = {
        isMetaMask: true,
        selectedAddress: address,
        get chainId() {
          return chainId
        },
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
          // A real injected wallet sits behind a postMessage bridge, so every
          // parameter is structured-cloned on its way out of the page. Doing
          // the same here is what makes this fake faithful in the one way that
          // matters: anything non-cloneable — a Svelte `$state` proxy, a class
          // instance, a function — fails HERE rather than only in MetaMask.
          params = structuredClone(params)
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address]
            case 'eth_chainId':
              return chainId
            case 'net_version':
              return String(Number(BigInt(chainId)))
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'wallet_addEthereumChain': {
              const chain = params[0] as { chainId?: string; rpcUrls?: string[] } | undefined
              const offered = chain?.rpcUrls?.[0]
              if (!chain?.chainId || !offered) {
                throw new Error(`refusing to add a chain described as ${JSON.stringify(chain)}`)
              }
              // MetaMask adds and switches in one prompt — and for a chain id
              // it already serves, adopts the offered RPC as the active one,
              // which is the only door out of the two-networks-one-id trap.
              endpoints[chain.chainId] = offered
              added.add(chain.chainId)
              chainId = chain.chainId
              for (const listener of listeners) {
                listener(chainId)
              }
              return null
            }
            case 'wallet_switchEthereumChain': {
              const target = (params[0] as { chainId?: string } | undefined)?.chainId
              // Only chains actually behind this provider; a switch anywhere
              // else would be a lie the deposit would expose.
              if (!target || !endpoints[target] || !added.has(target)) {
                throw Object.assign(new Error('Unrecognized chain'), { code: 4902 })
              }
              chainId = target
              for (const listener of listeners) {
                listener(chainId)
              }
              return null
            }
            default:
              if (method === 'eth_sendTransaction') {
                sends += 1
              }
              return rpc(method, params)
          }
        },
        on(event: string, listener: (value: unknown) => void) {
          if (event === 'chainChanged') {
            listeners.push(listener)
          }
        },
        removeListener: () => undefined,
      }
      Object.defineProperty(window, 'ethereum', { value: provider, writable: true })
    },
    [
      SOURCE_RPC_URL,
      CHAIN_RPC_URL,
      WALLET_ADDRESS,
      SOURCE_CHAIN_ID,
      GNOSIS_CHAIN_ID,
      misroutedGnosis,
    ] as const,
  )
}

/** Point the app at the local chains, and pin the rail ON. */
async function seedPaidEnvironment(page: Page) {
  await page.addInitScript(
    ([rpcUrl, beeUrl, sourceRpc]) => {
      localStorage.setItem(
        'swarm-id-network-settings',
        JSON.stringify({ beeNodeUrl: beeUrl, gnosisRpcUrl: rpcUrl }),
      )
      // Pin the source chain rather than inherit whatever is running, so the
      // rail resolves the same way here as it does in CI.
      localStorage.setItem('swarm-id-dev-source-rpc', sourceRpc)
    },
    [CHAIN_RPC_URL, BEE_NODE_URL, SOURCE_RPC_URL] as const,
  )
}

/** The batch the account ended up with, read out of its stored record. */
function storedDrive(page: Page) {
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data?: { postageStamps?: { batchID: string; signerKey: string }[] }[]
    }
    const stamp = doc.data?.[0]?.postageStamps?.[0]
    return stamp ? { batchID: stamp.batchID, signerKey: stamp.signerKey } : undefined
  })
}

/** The batch's owner per the PostageStamp contract, or undefined if unknown. */
async function onChainOwner(batchId: string): Promise<string | undefined> {
  const response = await fetch(CHAIN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: GNOSIS_POSTAGE_STAMP, data: `${BATCHES_SELECTOR}${batchId}` }, 'latest'],
    }),
  })
  const { result } = (await response.json()) as { result?: string }
  const owner = result?.slice(2, 2 + 64)
  return !owner || owner === ZERO_ADDRESS_WORD ? undefined : `0x${owner.slice(24)}`
}

/** Native balance on the source chain, for proving the deposit was real. */
async function sourceBalance(address: string): Promise<bigint> {
  const response = await fetch(SOURCE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
  })
  return BigInt(((await response.json()) as { result?: string }).result ?? '0x0')
}

/** `local-solver-protocol.ts` — the mock USDC the solver installs at startup. */
const SOURCE_USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
/** `balanceOf(address)` / `mint(address,uint256)` on the mock. */
const BALANCE_OF_SELECTOR = '0x70a08231'
const MINT_SELECTOR = '0x40c10f19'
/** Anvil account #8 signs the mint, keeping the wallet's and the solver's own
 * nonce streams (accounts #0 and #9) out of it. */
const MINTER_ADDRESS = '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f'

const abiAddress = (value: string): string =>
  value.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const abiAmount = (value: bigint): string => value.toString(16).padStart(64, '0')

async function sourceRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(SOURCE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) {
    throw new Error(`${method}: ${body.error.message}`)
  }
  return body.result
}

/** Mock-USDC balance on the source chain, in base units. */
async function sourceUsdc(address: string): Promise<bigint> {
  const result = (await sourceRpc('eth_call', [
    { to: SOURCE_USDC_ADDRESS, data: `${BALANCE_OF_SELECTOR}${abiAddress(address)}` },
    'latest',
  ])) as string
  if (result === '0x') {
    throw new Error('no mock USDC on the source chain — is the solver running? (pnpm dev:local)')
  }
  return BigInt(result)
}

/** Stock the paying wallet with mock USDC, through the token's open mint. */
async function mintUsdcTo(address: string, units: bigint): Promise<void> {
  // Probes the balance first: it fails loudly where a transaction to a
  // codeless address would succeed as a no-op.
  await sourceUsdc(address)
  await sourceRpc('eth_sendTransaction', [
    {
      from: MINTER_ADDRESS,
      to: SOURCE_USDC_ADDRESS,
      data: `${MINT_SELECTOR}${abiAddress(address)}${abiAmount(units)}`,
    },
  ])
}

/**
 * Buy a drive, paying from `chainId`, and return once the drive exists.
 *
 * The two chains take genuinely different routes — Gnosis is a direct transfer
 * with no bridge, anything else goes through the rail and its solver — but the
 * screens are identical, which is the point of the seam.
 */
async function buyPayingFrom(
  page: Page,
  chainId: number,
  { tokenAddress, misroutedGnosis }: { tokenAddress?: string; misroutedGnosis?: boolean } = {},
) {
  await injectPayingWallet(page, { misroutedGnosis })
  await seedPaidEnvironment(page)

  await page.goto('/')
  await page.getByRole('link', { name: 'Get started' }).first().click()
  await completeCreateFlow(page)
  await page.getByRole('button', { name: 'Stay local for now' }).click()

  // A brand-new account's postage signer holds nothing, so the purchase raises
  // a funding need and — with a source chain up — the rail carries it. No
  // settle: the payment screens opening IS the state under test.
  await addDrive(page, { settle: false })

  // 1. Method chooser. Buying leads with the widget, so pick the built-in
  //    method; the connect prompt appearing is proof the rail resolved rather
  //    than falling through to the faucet, which is what every other suite pins.
  await page
    .getByRole('dialog')
    .getByRole('combobox')
    .selectOption('Pay with crypto (built in, experimental)')
  await expect(page.getByText('Connect wallet to proceed')).toBeVisible({
    timeout: PAYMENT_TIMEOUT_MS,
  })

  // 2. Connect, through web3-onboard's own wallet chooser. This is the step
  //    that was unreachable until the overlay z-index was fixed. Connecting
  //    also offers the chain to the wallet, so a balance is visible before Pay.
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'MetaMask' }).click()
  await expect(page.getByText('Connected wallet')).toBeVisible({ timeout: PAYMENT_TIMEOUT_MS })

  // 3. Pick the chain — and token — to pay from, rather than relying on what
  //    leads the list: the ordering is a product decision and should not
  //    silently decide which route this test covers.
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').first().selectOption(String(chainId))
  if (tokenAddress) {
    await dialog.getByRole('combobox').nth(1).selectOption(tokenAddress)
  }

  // 4. A quote has to arrive before Pay is live — the button is disabled until
  //    the rail prices the delivery.
  const pay = page.getByRole('button', { name: 'Pay with your wallet' })
  await expect(pay).toBeEnabled({ timeout: PAYMENT_TIMEOUT_MS })
  // The breakdown is priced in the source token, per the designs.
  await expect(page.getByText(/xBZZ/)).toBeVisible()

  // 5. Pay. The wallet starts on Ethereum mainnet, so this negotiates a network
  //    switch to whichever chain was chosen before it can send anything.
  await pay.click()

  // 6. The drive appears only once the money has become storage: delivered (or
  //    transferred), swapped for BZZ on the real pool, createBatch confirmed.
  await expect(page.getByText(/^Drive [0-9a-f]{4}$/)).toBeVisible({
    timeout: PAYMENT_TIMEOUT_MS,
  })
}

/** The batch exists on chain and this account's own signer owns it. */
async function expectDriveOwnedBySigner(page: Page) {
  const drive = await storedDrive(page)
  expect(drive).toBeDefined()
  const owner = await onChainOwner(drive!.batchID)
  expect(owner).toBeDefined()
  const signerAddress = new PrivateKey(drive!.signerKey).publicKey().address().toHex()
  expect(owner!.toLowerCase()).toBe(`0x${signerAddress}`.toLowerCase())
}

test('paying from Gnosis needs no bridge at all', async ({ page }) => {
  test.setTimeout(PAYMENT_TIMEOUT_MS * 2)
  // The destination is the source, so the wallet just sends xDAI to the batch
  // owner. No rail, no solver, no invented prices — the only route that is the
  // same code locally as in production.
  await buyPayingFrom(page, GNOSIS_CHAIN_ID)
  await expectDriveOwnedBySigner(page)
})

test('paying from another chain goes through the rail and its solver', async ({ page }) => {
  test.setTimeout(PAYMENT_TIMEOUT_MS * 2)
  // The chain is long-lived and other runs have paid into it, so the deposit is
  // judged by a rise rather than by the balance being non-zero.
  const depositedBefore = await sourceBalance(LOCAL_SOLVER_ADDRESS)
  await buyPayingFrom(page, SOURCE_CHAIN_ID)
  // The deposit was real: the wallet's money actually reached the solver on
  // the source chain, rather than the flow completing on a faucet transfer.
  expect(await sourceBalance(LOCAL_SOLVER_ADDRESS)).toBeGreaterThan(depositedBefore)
  // One signature: the deposit is the payment, nothing to approve first.
  expect(await page.evaluate(() => (window as { __walletSends?: number }).__walletSends)).toBe(1)
  await expectDriveOwnedBySigner(page)
})

test('a wallet parked on the wrong chain 100 is walked to ours', async ({ page }) => {
  test.setTimeout(PAYMENT_TIMEOUT_MS * 2)
  // The user's own trap: chain 100 already in the wallet, its active endpoint
  // another network. A bare switch satisfies the id and every payment then
  // dies at the payer check — unless the switch verifies genesis and offers
  // the chain again, which is what this proves end to end.
  await buyPayingFrom(page, GNOSIS_CHAIN_ID, { misroutedGnosis: true })
  await expectDriveOwnedBySigner(page)
})

test('paying in a token takes an approve first, and the solver pulls it', async ({ page }) => {
  test.setTimeout(PAYMENT_TIMEOUT_MS * 2)
  // 100 USDC — comfortably above any quote, so the approve is what gates the
  // pull, not the balance.
  await mintUsdcTo(WALLET_ADDRESS, 100_000_000n)
  const pulledBefore = await sourceUsdc(LOCAL_SOLVER_ADDRESS)
  await buyPayingFrom(page, SOURCE_CHAIN_ID, { tokenAddress: SOURCE_USDC_ADDRESS })
  // Two signatures, the way Relay's own ERC-20 step model reads: the approve
  // granting the solver its pull, then the value-less deposit.
  expect(await page.evaluate(() => (window as { __walletSends?: number }).__walletSends)).toBe(2)
  // The pull was real: the solver collected the token before it filled.
  expect(await sourceUsdc(LOCAL_SOLVER_ADDRESS)).toBeGreaterThan(pulledBefore)
  await expectDriveOwnedBySigner(page)
})
