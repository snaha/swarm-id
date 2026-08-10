<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { BatchId, Bee, EthAddress, Identifier, PrivateKey } from '@ethersphere/bee-js'
  import {
    derivePostageSignerKey,
    downloadEncryptedSOC,
    rejectAfter,
    uint8ArrayToHex,
    uploadSOC,
  } from '@snaha/swarm-id'
  import { gnosisMainnetSettings } from '@swarm-id/multichain'
  import { type Chain, formatUnits, parseUnits } from 'viem'

  import { resolve } from '$app/paths'

  import CopyButton from '$lib/components/copy-button.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { Tabs } from '$lib/components/ui/tabs'
  import {
    ANVIL_ACCOUNT,
    type FundsRow,
    createOwnedBatchOnChain,
    createTestDrive,
    devChainFunds,
    sendFromFaucet,
  } from '$lib/dev/chain-funding'
  import { localSourceRpcUrl, sourceEthBalance } from '$lib/dev/local-payment-rail'
  import { postageStampsStore } from '$lib/dev/postage-stamps.svelte'
  import { syncStore } from '$lib/dev/sync.svelte'
  import { fetchExistingBatchFromChain } from '$lib/payment/contract'
  import { type EthereumProvider, switchWalletChain } from '$lib/payment/payment-rail'
  import { chainIdentity, postageChain } from '$lib/payment/postage-onchain'
  import { resolvePaymentRail } from '$lib/payment/resolve-rail'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'

  import DeviceList from './device-list.svelte'
  import StatusDot from './status-dot.svelte'

  // The Swarm publish hook is now installed app-wide in the root layout
  // (`+layout.svelte`), so /dev no longer manages it — a local install +
  // unmount cleanup here would toggle publishing off for the whole app on
  // navigating away.

  // Every live (non-tombstoned) stamp across all accounts — the account owns its
  // stamps now, and a removed stamp lingers as a `deletedAt` tombstone so its
  // deletion can propagate, so list only the live stamps.
  const allStamps = $derived(accountsStore.accounts.flatMap((a) => a.stamps))

  // Same set, but carrying the owning account — the Stored Stamps list needs the
  // account id to delete a stamp from its nested collection.
  const storedStampRows = $derived(
    accountsStore.accounts.flatMap((a) =>
      a.stamps.map((stamp) => ({ accountId: a.id, accountName: a.name, stamp })),
    ),
  )
  let storedStampMessage = $state('')

  // Delete a single stored stamp (dev cleanup — replaces the old hand-edit of
  // localStorage). `removeStamp` tombstones the stamp (`deletedAt`) and lets the
  // deletion sync: `mergePostageStamps` keeps the tombstone (#337), so a peer's
  // fold no longer resurrects it.
  function deleteStoredStamp(accountId: EthAddress, batchID: BatchId) {
    accountsStore.getAccount(accountId)?.removeStamp(batchID)
    storedStampMessage = `🗑️ Removed ${batchID.toHex().slice(0, 12)}…`
  }

  // Tab state
  let activeTab = $state('overview')

  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'chain', label: 'Chain' },
    { value: 'node', label: 'Node' },
    { value: 'devices', label: 'Devices' },
  ]

  // Demo app URL for connect flow testing (the new UI's demo runs on :3500).
  const demoAppOrigin = 'http://localhost:3500'

  // Sync state
  let syncMessage = $state('')

  let selectedAccountId = $state('')

  // Derived postage signer key + owner address for the selected account.
  // Use the owner address to buy a stamp online, then paste the private key into
  // the "Use existing one" screen as the signer key.
  let accountSigner = $state<{ privateKey: string; owner: string } | undefined>(undefined)

  $effect(() => {
    const acct = selectedAccountId
      ? accountsStore.getAccount(new EthAddress(selectedAccountId))
      : undefined
    if (!acct) {
      accountSigner = undefined
      return
    }
    // Fire-and-forget derive with a staleness guard: two quick account
    // switches can resolve out of order, and this card renders key material —
    // never label one account's private key with another account selected.
    const requestedId = selectedAccountId
    void (async () => {
      const k = await derivePostageSignerKey(acct.derivationKey)
      if (selectedAccountId !== requestedId) return
      accountSigner = { privateKey: k, owner: new PrivateKey(k).publicKey().address().toHex() }
    })()
  })
  // On-chain drive tooling: fund the account's postage signer and create a
  // batch it OWNS, so extend/resize can run for real against the local chain.
  let chainToolBusy = $state(false)
  let chainToolMessage = $state('')
  let chainToolError = $state('')

  // Faucet panel. Amounts are what you type — no hidden multiplier, since the
  // point of the panel is to hand over an exact amount and watch it land.
  const ETH_DECIMALS = 18
  const XDAI_DECIMALS = 18
  const BZZ_DECIMALS = 16
  const AMOUNT_PRECISION = 4
  /** Stands in where a chain has no figure to give, rather than a lying zero. */
  const NO_FIGURE = '—'
  let faucetTo = $state('')
  let faucetEth = $state('1')
  let faucetXdai = $state('0.05')
  let faucetBzz = $state('1')
  let faucetBusy = $state(false)
  let faucetMessage = $state('')
  let faucetError = $state('')
  let funds = $state<{ faucet: FundsRow; recipient: FundsRow } | undefined>(undefined)
  /** Undefined means the source chain never answered — NOT a zero balance. */
  let sourceEth = $state<bigint | undefined>(undefined)
  let fundsError = $state('')

  // The typed recipient, normalized. Undefined while it is not an address,
  // which is also what disables Send.
  const faucetRecipient = $derived.by(() => {
    try {
      return new EthAddress(faucetTo.trim()).toChecksum()
    } catch {
      return undefined
    }
  })

  /**
   * Read one amount box. Anything that is not a positive number means "skip
   * this leg" rather than an error — a half-typed figure in one box must not
   * take down the send, or the panel, with it.
   */
  function faucetAmount(typed: string, decimals: number): bigint {
    const value = typed.trim()
    if (!(Number(value) > 0)) return 0n
    try {
      return parseUnits(value, decimals)
    } catch {
      return 0n
    }
  }

  // What a send actually delivers, so the confirmation never claims a leg that
  // did not happen — and so Send is disabled when every box is empty.
  const faucetLegs = $derived(
    [
      { typed: faucetEth, symbol: 'ETH', value: faucetAmount(faucetEth, ETH_DECIMALS) },
      { typed: faucetXdai, symbol: 'xDAI', value: faucetAmount(faucetXdai, XDAI_DECIMALS) },
      { typed: faucetBzz, symbol: 'BZZ', value: faucetAmount(faucetBzz, BZZ_DECIMALS) },
    ].filter((leg) => leg.value > 0n),
  )

  // Point the faucet at the selected account's signer, and re-point it when the
  // account changes — reaching for Send with the previous account's address
  // still in the box is the trap this panel would otherwise set. Only the value
  // we filled in is ever replaced; anything typed or pasted is left alone.
  let prefilledSigner = ''
  $effect(() => {
    if (!accountSigner) return
    const owner = new EthAddress(accountSigner.owner).toChecksum()
    if (owner === prefilledSigner) return
    if (faucetTo === '' || faucetTo === prefilledSigner) faucetTo = owner
    prefilledSigner = owner
  })

  function formatAmount(value: bigint, decimals: number): string {
    return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
      maximumFractionDigits: AMOUNT_PRECISION,
    })
  }

  async function refreshFunds() {
    const requested = faucetRecipient
    if (!requested) {
      funds = undefined
      sourceEth = undefined
      fundsError = ''
      return
    }
    const [gnosis, eth] = await Promise.allSettled([
      devChainFunds(requested),
      sourceEthBalance(requested),
    ])
    // Typing an address fires this per keystroke and two reads can land out of
    // order — never show one address's balances under another.
    if (faucetRecipient !== requested) return
    if (gnosis.status === 'fulfilled') {
      funds = gnosis.value
      fundsError = ''
    } else {
      funds = undefined
      fundsError = gnosis.reason instanceof Error ? gnosis.reason.message : String(gnosis.reason)
    }
    // A missing source chain is the ordinary case here — most sessions never
    // start one — so it reads as a dash in the table, not an error over the
    // Gnosis figures that did arrive.
    sourceEth = eth.status === 'fulfilled' ? eth.value : undefined
  }

  // Re-read whenever the recipient changes; the Chain tab is the only consumer,
  // so this costs nothing on a tab most sessions never open.
  $effect(() => {
    if (activeTab === 'chain' && faucetRecipient) {
      void refreshFunds()
    }
  })

  /** The rows of the balances table, formatted. */
  const balanceRows = $derived.by(() => {
    const rows: { label: string; address: string; eth: string; xdai: string; bzz: string }[] = []
    if (faucetRecipient) {
      rows.push({
        label: 'Recipient',
        address: faucetRecipient,
        eth: sourceEth === undefined ? NO_FIGURE : formatAmount(sourceEth, ETH_DECIMALS),
        xdai: funds ? formatAmount(funds.recipient.xdai, XDAI_DECIMALS) : NO_FIGURE,
        bzz: funds ? formatAmount(funds.recipient.bzz, BZZ_DECIMALS) : NO_FIGURE,
      })
    }
    if (funds) {
      rows.push({
        label: 'Faucet',
        address: funds.faucet.address,
        // The faucet holds nothing on the source chain and never will: there is
        // no account to stock there, since anvil mints on request.
        eth: NO_FIGURE,
        xdai: formatAmount(funds.faucet.xdai, XDAI_DECIMALS),
        bzz: formatAmount(funds.faucet.bzz, BZZ_DECIMALS),
      })
    }
    return rows
  })

  function fillFromSigner() {
    if (accountSigner) faucetTo = new EthAddress(accountSigner.owner).toChecksum()
  }

  /**
   * Fill the recipient from the injected wallet — the account a rehearsed
   * payment is signed with, and so the one that needs source-chain ETH.
   */
  async function fillFromWallet() {
    faucetError = ''
    const injected = (window as { ethereum?: EthereumProvider }).ethereum
    if (!injected) {
      faucetError = 'No injected wallet found — is MetaMask installed and enabled here?'
      return
    }
    try {
      const [account] = (await injected.request({ method: 'eth_requestAccounts' })) as string[]
      if (!account) {
        faucetError = 'The wallet returned no account.'
        return
      }
      faucetTo = new EthAddress(account).toChecksum()
    } catch (error) {
      faucetError = error instanceof Error ? error.message : String(error)
    }
  }

  async function sendFaucetFunds() {
    const to = faucetRecipient
    if (!to) return
    faucetBusy = true
    faucetMessage = ''
    faucetError = ''
    const delivered = faucetLegs.map((leg) => `${leg.typed.trim()} ${leg.symbol}`).join(' + ')
    try {
      await sendFromFaucet(to, {
        eth: faucetAmount(faucetEth, ETH_DECIMALS),
        xdai: faucetAmount(faucetXdai, XDAI_DECIMALS),
        bzzPlur: faucetAmount(faucetBzz, BZZ_DECIMALS),
      })
      faucetMessage = `✅ Sent ${delivered} to ${to}`
    } catch (error) {
      faucetError = error instanceof Error ? error.message : String(error)
    } finally {
      faucetBusy = false
    }
    await refreshFunds()
  }

  // RAW: these descriptors are handed to a wallet, which structured-clones its
  // arguments, and a `$state` proxy cannot be cloned.
  let walletChains = $state.raw<Chain[]>([])
  let walletMessage = $state('')

  // Read from the resolved rails rather than listed here, so this offers
  // exactly the chains the payment screens will ask the wallet for.
  $effect(() => {
    if (activeTab === 'chain') {
      void resolvePaymentRail().then((rail) => {
        walletChains = rail ? [...rail.chains] : []
      })
    }
  })

  /**
   * Add a chain to the injected wallet, and switch to it.
   *
   * Adding is what makes a wallet show a balance for a network at all, so doing
   * it here means the payment screens are reached with something already
   * visible rather than an account that looks empty.
   */
  async function addChainToWallet(chain: Chain) {
    walletMessage = ''
    const injected = (window as { ethereum?: EthereumProvider }).ethereum
    if (!injected) {
      walletMessage = '❌ No injected wallet found — is MetaMask installed and enabled here?'
      return
    }
    try {
      // MetaMask ignores chain requests from a site it has never been connected
      // to, so ask for accounts first even though nothing here needs one.
      await injected.request({ method: 'eth_requestAccounts' })
      await switchWalletChain(injected, chain.id, walletChains)
      walletMessage = `✅ ${chain.name} added — the wallet is on it now.`
    } catch (e) {
      walletMessage = `❌ ${e instanceof Error ? e.message : String(e)}`
    }
  }

  async function runChainTool(
    label: string,
    action: (derivationKey: string, account: Account) => Promise<string>,
  ) {
    const account = selectedAccountId
      ? accountsStore.getAccount(new EthAddress(selectedAccountId))
      : undefined
    if (!account) {
      chainToolError = 'Select an account first.'
      return
    }
    chainToolBusy = true
    chainToolMessage = ''
    chainToolError = ''
    try {
      chainToolMessage = `${label}: ${await action(account.derivationKey, account)}`
    } catch (e) {
      chainToolError = e instanceof Error ? e.message : String(e)
    } finally {
      chainToolBusy = false
    }
  }

  // Retrievability self-check: does the configured Bee node serve back a SOC we
  // just wrote? (If not, no cross-device coordination — lock/intent/presence
  // SOCs — can work there, and normal sync/download is unreliable too.)
  let selfCheckStampId = $state('')
  let selfCheckRunning = $state(false)
  let selfCheckLog = $state<string[]>([])
  // The address of the just-written test SOC — copy it to another device's
  // "Read by address" to test cross-device retrievability.
  let selfCheckSocAddress = $state('')

  // Cross-device check: read a chunk BY ADDRESS that another device wrote
  // (paste the SOC address printed by that device's self-check). On a
  // load-balanced gateway the writer can read its own write back from its own
  // backend, but a different device may hit a backend that can't retrieve it —
  // this is the read that actually mirrors cross-device coordination.
  let readAddr = $state('')
  let readChecking = $state(false)
  let readLog = $state<string[]>([])

  // Partition-coordination timing overrides (gateway propagation tuning). Read
  // by the proxy from this localStorage key on connect; blank fields fall back
  // to the lib defaults. Must match PARTITION_TUNING_KEY in swarm-id-proxy.ts.
  const PARTITION_TUNING_KEY = 'swarm-id-partition-tuning'
  function loadTuning(): {
    guardWindowMs?: number
    guardPollMs?: number
    readTimeoutMs?: number
  } {
    if (typeof localStorage === 'undefined') return {}
    try {
      return JSON.parse(localStorage.getItem(PARTITION_TUNING_KEY) ?? '{}') ?? {}
    } catch {
      return {}
    }
  }
  const initialTuning = loadTuning()
  let tuningWindow = $state(initialTuning.guardWindowMs?.toString() ?? '')
  let tuningPoll = $state(initialTuning.guardPollMs?.toString() ?? '')
  let tuningTimeout = $state(initialTuning.readTimeoutMs?.toString() ?? '')
  let tuningSaved = $state('')

  function saveTuning() {
    const obj: Record<string, number> = {}
    const add = (key: string, raw: string) => {
      const n = Number(raw)
      if (raw.trim() !== '' && Number.isFinite(n) && n >= 0) obj[key] = n
    }
    add('guardWindowMs', tuningWindow)
    add('guardPollMs', tuningPoll)
    add('readTimeoutMs', tuningTimeout)
    localStorage.setItem(PARTITION_TUNING_KEY, JSON.stringify(obj))
    tuningSaved = `Saved ${JSON.stringify(obj)} — reload the app/proxy to apply.`
  }
  function resetTuning() {
    localStorage.removeItem(PARTITION_TUNING_KEY)
    tuningWindow = ''
    tuningPoll = ''
    tuningTimeout = ''
    tuningSaved = 'Cleared — reload to use defaults (window 12000 / poll 2500 / read 2500 ms).'
  }

  // Per-read timeout and the elapsed-since-upload checkpoints to poll at.
  const SELF_CHECK_READ_TIMEOUT_MS = 3000
  const SELF_CHECK_POLL_MS = [0, 2000, 5000, 10000, 20000]
  const RANDOM_BYTES = 32

  function randomBytes(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(RANDOM_BYTES))
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function runRetrievabilityCheck() {
    selfCheckRunning = true
    const log: string[] = []
    selfCheckLog = log
    const push = (line: string) => {
      log.push(line)
      selfCheckLog = [...log]
    }
    try {
      const stamp = allStamps.find((s) => s.batchID.toHex() === selfCheckStampId)
      if (!stamp) {
        push('❌ Select a stored stamp to pay for the test chunk.')
        return
      }
      const nodeUrl = networkSettingsStore.beeNodeUrl
      const bee = new Bee(nodeUrl)
      // Throwaway, fresh-per-run SOC: random owner key + identifier + encryption
      // key + payload. Postage is paid by the stamp's signerKey; the SOC is
      // owned by the throwaway signer — the same split a real presence beacon
      // uses. A fresh address guarantees the read isn't served from a stale
      // local cache.
      const signer = new PrivateKey(randomBytes())
      const encryptionKey = randomBytes()
      const identifier = new Identifier(randomBytes())
      const owner = signer.publicKey().address()

      const stamper = await postageStampsStore.getStamper(stamp.batchID, {
        owner,
        encryptionKey,
      })
      if (!stamper) {
        push('❌ Could not build a stamper for that batch.')
        return
      }

      push(`Node: ${nodeUrl}`)
      push(`Batch: ${stamp.batchID.toHex().slice(0, 12)}… (depth ${stamp.depth})`)
      const t0 = Date.now()
      const { socAddress } = await uploadSOC(
        { mode: 'stamper', bee, stamper },
        signer,
        identifier,
        randomBytes(),
        { encryptionKey },
      )
      const addrHex = uint8ArrayToHex(socAddress)
      selfCheckSocAddress = addrHex
      push(`✅ Upload OK in ${Date.now() - t0}ms — SOC address ${addrHex}`)

      let retrievedMs: number | undefined
      let prev = 0
      for (const checkpoint of SELF_CHECK_POLL_MS) {
        await sleep(Math.max(0, checkpoint - prev))
        prev = checkpoint
        try {
          await Promise.race([
            downloadEncryptedSOC(bee, owner, identifier, encryptionKey),
            rejectAfter(SELF_CHECK_READ_TIMEOUT_MS, 'read timed out'),
          ])
          retrievedMs = Date.now() - t0
          break
        } catch (error) {
          push(
            `  read @ ${checkpoint}ms: not yet (${error instanceof Error ? error.message : String(error)})`,
          )
        }
      }

      if (retrievedMs !== undefined) {
        push(
          `✅ Retrievable after ${retrievedMs}ms → this node serves back writes; multi-device coordination can work here.`,
        )
      } else {
        push(
          `❌ NOT retrievable within ~${SELF_CHECK_POLL_MS[SELF_CHECK_POLL_MS.length - 1] / 1000}s → this node does not serve back recently-written chunks. Cross-device coordination (lock/intent/presence SOCs) cannot work here, and normal sync/download will be unreliable too.`,
        )
      }
    } catch (error) {
      push(`❌ Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      selfCheckRunning = false
    }
  }

  async function runReadByAddress() {
    readChecking = true
    const log: string[] = []
    readLog = log
    const push = (line: string) => {
      log.push(line)
      readLog = [...log]
    }
    try {
      const addr = readAddr.trim().replace(/^0x/, '')
      if (!/^[0-9a-fA-F]{64}$/.test(addr)) {
        push('❌ Enter a 64-char hex chunk address (the SOC address from another device).')
        return
      }
      const nodeUrl = networkSettingsStore.beeNodeUrl
      const bee = new Bee(nodeUrl)
      push(`Node: ${nodeUrl}`)
      const t0 = Date.now()
      let foundMs: number | undefined
      let prev = 0
      for (const checkpoint of SELF_CHECK_POLL_MS) {
        await sleep(Math.max(0, checkpoint - prev))
        prev = checkpoint
        try {
          await Promise.race([
            bee.downloadChunk(addr),
            rejectAfter(SELF_CHECK_READ_TIMEOUT_MS, 'read timed out'),
          ])
          foundMs = Date.now() - t0
          break
        } catch (error) {
          push(
            `  read @ ${checkpoint}ms: not yet (${error instanceof Error ? error.message : String(error)})`,
          )
        }
      }
      if (foundMs !== undefined) {
        push(
          `✅ Retrievable after ${foundMs}ms → this device CAN read the chunk the other device wrote; cross-device coordination can work.`,
        )
      } else {
        push(
          `❌ NOT retrievable within ~${SELF_CHECK_POLL_MS[SELF_CHECK_POLL_MS.length - 1] / 1000}s → this device cannot read the other device's chunk. The gateway isn't serving writes across nodes/sessions, so cross-device coordination cannot work here.`,
        )
      }
    } catch (error) {
      push(`❌ Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      readChecking = false
    }
  }

  // Stored stamps (with signerKey) usable to pay for the retrievability check.
  const storedStampOptions = $derived(
    allStamps.map((stamp) => ({
      value: stamp.batchID.toHex(),
      label: `${stamp.batchID.toHex().slice(0, 10)}… (depth ${stamp.depth})`,
    })),
  )
  $effect(() => {
    if (storedStampOptions.length && !selfCheckStampId) {
      selfCheckStampId = storedStampOptions[0].value
    }
  })
  const accountOptions = $derived(
    accountsStore.accounts.map((account) => ({
      value: account.id.toHex(),
      label: `${account.name} (${account.id.toHex().slice(0, 10)}…)`,
    })),
  )
  const selectedAccount = $derived(
    selectedAccountId ? accountsStore.getAccount(new EthAddress(selectedAccountId)) : undefined,
  )

  $effect(() => {
    if (accountOptions.length && !selectedAccountId) {
      selectedAccountId = accountOptions[0].value
    } else if (
      selectedAccountId &&
      !accountOptions.some((option) => option.value === selectedAccountId)
    ) {
      selectedAccountId = accountOptions[0]?.value ?? ''
    }
  })

  async function triggerManualSync() {
    // Get all accounts with a default stamp.
    const accountsToSync = accountsStore.accounts.filter(
      (account) => account.defaultPostageStampBatchID,
    )

    if (accountsToSync.length === 0) {
      syncMessage = '❌ No accounts with default postage stamps found.'
      return
    }

    syncMessage = `⏳ Syncing ${accountsToSync.length} accounts...`

    const results: string[] = []
    let successCount = 0
    let errorCount = 0

    for (const account of accountsToSync) {
      try {
        const result = await syncStore.syncAccount(account.id.toHex())

        if (!result) {
          results.push(`⚠️ ${account.name}: no snapshot captured (missing stamp?)`)
          errorCount++
          continue
        }

        if (result.status === 'error') {
          results.push(`❌ ${account.name}: ${result.error}`)
          errorCount++
          continue
        }

        // Get default stamp to show utilization
        const defaultStamp = account.defaultPostageStampBatchID
        const stamp = defaultStamp ? postageStampsStore.getStamp(defaultStamp) : undefined
        const utilization = stamp ? stamp.utilization.toFixed(2) : 'unknown'

        if (result.status === 'success-unverified') {
          results.push(
            `⚠️ ${account.name}: synced, but root chunk not retrievable — ${result.warning}`,
          )
          errorCount++
          continue
        }

        results.push(`✅ ${account.name}: ${utilization}% utilization`)
        successCount++
      } catch (error) {
        results.push(
          `❌ ${account.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
        errorCount++
      }
    }

    syncMessage = `Sync completed: ${successCount} succeeded, ${errorCount} failed

${results.join('\n')}

Check console logs for details:
- [StateSync] Tracking X chunks
- [StateSync] New utilization: Y%
- [PostageStamps] Updated utilization`
  }

  // Import a batch by ID, reading its parameters from the PostageStamp contract
  // ON-CHAIN (not from a Bee node) — works for any batch id even when the
  // configured node never saw it. The signer key is NOT on-chain, so the user
  // supplies it (required to sign uploads with the batch). The local anvil
  // deployment address is shared from `$lib/payment/contract`.

  let importBatchId = $state('')
  let importSignerKey = $state('')
  // Defaults to the shared network setting, like every other dev tool here —
  // reading a batch from one chain while the app talks to another is a trap.
  let importRpcUrl = $state(networkSettingsStore.gnosisRpcUrl)
  // Blank → resolve from the chain the RPC serves; a value overrides.
  let importContractOverride = $state('')
  let importSetDefault = $state(true)
  let importing = $state(false)
  let importMessage = $state('')
  let importError = $state('')

  // Contract address the read will use: the override if set, else whatever the
  // endpoint's chain reports. Every chain the app supports carries PostageStamp
  // at the Gnosis address, so that is also the fallback when the probe fails.
  const DEFAULT_POSTAGE_STAMP = gnosisMainnetSettings().addresses.postageStamp
  let resolvedContract = $state<string>(DEFAULT_POSTAGE_STAMP)
  $effect(() => {
    const url = importRpcUrl.trim()
    void postageChain(url)
      .then((chain) => (resolvedContract = chain.settings.addresses.postageStamp))
      .catch(() => (resolvedContract = DEFAULT_POSTAGE_STAMP))
  })

  async function importBatchById() {
    importError = ''
    importMessage = ''
    if (!importBatchId.trim() || !importSignerKey.trim() || !selectedAccountId) {
      importError = 'Enter a batch ID and signer key, and select an account.'
      return
    }
    importing = true
    try {
      const batchId = new BatchId(importBatchId.trim())
      const signerKey = new PrivateKey(importSignerKey.trim())
      const account = accountsStore.getAccount(new EthAddress(selectedAccountId))
      if (!account) {
        importError = 'Account not found.'
        return
      }

      const stamp = await fetchExistingBatchFromChain(batchId.toHex(), signerKey, '', {
        rpcUrl: importRpcUrl.trim(),
        // Only force an address when the user typed one; otherwise let the
        // read resolve it from the chain the RPC actually serves.
        contractAddress: importContractOverride.trim() || undefined,
      })
      if (!stamp) {
        importError =
          'Could not read the batch from the chain — no such batch here, or the RPC URL / contract address is wrong.'
        return
      }

      account.addStamp(stamp)
      if (importSetDefault) account.setDefaultStamp(stamp.batchID)
      importMessage =
        `✅ Imported ${batchId.toHex().slice(0, 12)}… (depth ${stamp.depth}` +
        `${stamp.immutableFlag ? ', immutable — partition sharing needs a mutable batch' : ''}) ` +
        `into ${account.name}`
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error)
    } finally {
      importing = false
    }
  }

  // Clear this browser's accounts (which own their apps + stamps) + session.
  /** Every account on the device, not just a selected one. */
  function clearAccounts() {
    accountsStore.clear()
    sessionStore.clearCurrentAccount()
  }

  // Full reset: every swarm* localStorage key + the IndexedDB utilization DB,
  // then reload so all in-memory stores re-init from empty storage. onblocked
  // resolves too — an open DB connection is closed by the reload, letting the
  // pending delete finish.
  async function clearAll() {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('swarm')) localStorage.removeItem(key)
    }
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('swarm-utilization-store')
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
    location.reload()
  }

  // Clears the account's DEFAULT-stamp pointer only; the stamp stays in the
  // account's stamps (delete it outright in "Stored Stamps" above). Assign is
  // the symmetric op — it sets the default.

  const LABEL_CLASS = 'flex flex-col gap-1.5 text-sm'
  const LABEL_TEXT_CLASS = 'text-muted-foreground'
  const CARD_CLASS = 'flex flex-col gap-2 rounded-lg border bg-card p-4'
</script>

{#snippet chainBanner(label: string, detail: string, alarming: boolean)}
  <div
    class="rounded-md border px-4 py-3 text-sm {alarming
      ? 'border-destructive bg-destructive/10 text-destructive font-medium'
      : 'border-border text-muted-foreground'}"
  >
    <span>{label}</span>
    <span class="font-mono">{detail}</span>
  </div>
{/snippet}

{#snippet copyRow(label: string, value: string, mono = true)}
  <div class="flex flex-col gap-1.5">
    <span class="text-muted-foreground text-sm">{label}</span>
    <div class="flex items-center gap-2">
      <span class={`text-sm break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
      <CopyButton text={value} />
    </div>
  </div>
{/snippet}

{#snippet signerCard(label: string, signer: { privateKey: string; owner: string })}
  <div class={CARD_CLASS}>
    <p class="font-mono text-sm font-semibold">{label}</p>
    {@render copyRow('Owner Address', signer.owner)}
    {@render copyRow('Private Key', signer.privateKey)}
  </div>
{/snippet}

<div class="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8">
  <h2 class="text-xl font-bold">Developer Tools</h2>

  <!--
    Which chain these tools are pointed at. Every action on this page spends,
    and a dev chain reports the same chain id as mainnet on purpose — so the
    only honest answer comes from the genesis hash. Red is for MAINNET: on this
    page that is the state nobody intends to be in.
  -->
  {#await chainIdentity(networkSettingsStore.gnosisRpcUrl)}
    {@render chainBanner('Checking the chain at ', networkSettingsStore.gnosisRpcUrl, false)}
  {:then identity}
    {#if identity.isMainnet}
      {@render chainBanner(
        'GNOSIS MAINNET — these tools spend real funds. ',
        networkSettingsStore.gnosisRpcUrl,
        true,
      )}
    {:else}
      {@render chainBanner(
        'Local dev chain, nothing here is real. ',
        networkSettingsStore.gnosisRpcUrl,
        false,
      )}
    {/if}
  {:catch}
    {@render chainBanner('No chain reachable at ', networkSettingsStore.gnosisRpcUrl, true)}
  {/await}

  <Tabs {tabs} bind:value={activeTab} />

  <!--
    Under the tabs, and only for the tabs that act on ONE account: Chain signs
    with its derived postage signer, Devices lists its devices. Overview and
    Node read across every account, so a selector there would imply a scoping
    they do not have — and placing it above would shift the tabs each time it
    appeared.
  -->
  {#if activeTab === 'chain' || activeTab === 'devices'}
    <label class={LABEL_CLASS}>
      <span class={LABEL_TEXT_CLASS}>Account these tools act on</span>
      <Select options={accountOptions} bind:value={selectedAccountId} />
    </label>
  {/if}

  <!-- Overview Tab -->
  {#if activeTab === 'overview'}
    {@const accountCount = accountsStore.accounts.length}
    {@const connectionCount = accountsStore.accounts.reduce(
      (n, a) => n + a.connectedApps.length,
      0,
    )}
    {@const stampCount = allStamps.length}
    {@const connectUrl = `${resolve(routes.CONNECT)}?origin=${encodeURIComponent(demoAppOrigin)}`}
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <h4 class="text-sm font-semibold">Local Bee Endpoints</h4>
        <!--
          These hrefs are absolute http(s) endpoints read from network settings —
          never app routes — which a dynamic href cannot prove to the rule.
        -->
        <!-- eslint-disable svelte/no-navigation-without-resolve -->
        <div class="flex items-center gap-2">
          <StatusDot endpoint={networkSettingsStore.beeNodeUrl} />
          <span class="font-mono text-sm">Bee node:</span>
          <a
            href={networkSettingsStore.beeNodeUrl}
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">{networkSettingsStore.beeNodeUrl}</a
          >
          <CopyButton text={networkSettingsStore.beeNodeUrl} />
        </div>
        <div class="flex items-center gap-2">
          <StatusDot endpoint="http://localhost:16331" />
          <span class="font-mono text-sm">Cluster worker:</span>
          <a
            href="http://localhost:16331"
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">http://localhost:16331</a
          >
          <CopyButton text="http://localhost:16331" />
        </div>
        <div class="flex items-center gap-2">
          <StatusDot endpoint={networkSettingsStore.gnosisRpcUrl} method="json-rpc" />
          <span class="font-mono text-sm">Gnosis Chain RPC (fake):</span>
          <a
            href={networkSettingsStore.gnosisRpcUrl}
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">{networkSettingsStore.gnosisRpcUrl}</a
          >
          <CopyButton text={networkSettingsStore.gnosisRpcUrl} />
        </div>
        <div class="flex items-center gap-2">
          <StatusDot endpoint={localSourceRpcUrl()} method="json-rpc" />
          <span class="font-mono text-sm">Ethereum Mainnet RPC (fake):</span>
          <a
            href={localSourceRpcUrl()}
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">{localSourceRpcUrl()}</a
          >
          <CopyButton text={localSourceRpcUrl()} />
        </div>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      </div>

      <div class="flex flex-col gap-2">
        <h4 class="text-sm font-semibold">Test Connect Flow</h4>
        <p class="text-sm">Test the connect flow with the demo app:</p>
        <div class="flex items-center gap-2">
          <StatusDot endpoint={demoAppOrigin} />
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- template literal with resolve() -->
          <a href={connectUrl} class="text-primary font-mono text-sm">localhost:3500 (demo)</a>
          <CopyButton text={connectUrl} />
        </div>
      </div>

      <div class="flex flex-col items-start gap-2">
        <h4 class="text-sm font-semibold">Local Data</h4>
        <p class="text-sm">
          {accountCount} accounts, {connectionCount} connections, {stampCount} stamps
        </p>
        <p class="text-muted-foreground text-xs">
          Every account on this device is listed here — the product UI, /dev and sync all read the
          one shared account store, so accounts show up as soon as they're created (no dApp
          connection required).
        </p>
        <div class="flex gap-2">
          <Button variant="destructive" onclick={clearAccounts}>Clear accounts</Button>
          <Button variant="destructive" onclick={clearAll}>Clear everything</Button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Node Tab: everything that talks to the Bee node -->
  {#if activeTab === 'node'}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-semibold">Stored Stamps (local)</h3>
      <p class="text-muted-foreground text-sm">
        The postage batches saved in this browser. Copy these fields before clearing storage — paste
        them into the "Use existing one" screen to re-adopt the same batch on a fresh account (the
        owner is derived from the signer key). Delete removes the stamp locally only (no sync).
      </p>
      {#if storedStampMessage}
        <p class="font-mono text-sm">{storedStampMessage}</p>
      {/if}
      {#if storedStampRows.length === 0}
        <p class="text-muted-foreground text-sm">No stamps stored locally.</p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each storedStampRows as { accountId, accountName, stamp } (stamp.batchID.toHex())}
            <div class={CARD_CLASS}>
              {@render copyRow('Batch ID', stamp.batchID.toHex())}
              {@render copyRow('Signer Key', stamp.signerKey.toHex())}
              <div class="flex gap-8">
                {@render copyRow('Amount', stamp.amount.toString())}
                {@render copyRow('Depth', String(stamp.depth))}
                {@render copyRow('Block number', String(stamp.blockNumber))}
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground text-sm">Account: {accountName}</span>
                <Button
                  variant="destructive"
                  size="sm"
                  onclick={() => deleteStoredStamp(accountId, stamp.batchID)}>Delete</Button
                >
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Retrievability self-check</h3>
      <p class="text-muted-foreground text-sm">
        Writes a throwaway single-owner chunk to the configured Bee node ({networkSettingsStore.beeNodeUrl})
        and reads it back, to confirm the node actually serves back what you write. Multi-device
        coordination (and reliable sync/download) only works when this succeeds.
      </p>
      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Pay with stored stamp</span>
          <Select options={storedStampOptions} bind:value={selfCheckStampId} />
        </label>
        <Button onclick={runRetrievabilityCheck} disabled={selfCheckRunning || !selfCheckStampId}>
          {selfCheckRunning ? 'Checking…' : 'Run self-check'}
        </Button>
      </div>
      {#if selfCheckLog.length}
        <div class={CARD_CLASS}>
          {#each selfCheckLog as line, i (i)}
            <p class="font-mono text-sm break-all">{line}</p>
          {/each}
          {#if selfCheckSocAddress}
            <div class="flex items-center gap-2">
              <span class="text-muted-foreground text-sm"
                >SOC address (copy to another device):</span
              >
              <CopyButton text={selfCheckSocAddress} />
            </div>
          {/if}
        </div>
      {/if}

      <p class="text-muted-foreground mt-2 text-sm">
        Cross-device check: run the self-check on another device, copy its SOC address, paste it
        here, and read it back. The writer reading its own chunk can succeed on a load-balanced
        gateway even when a different device cannot — this is the read that mirrors coordination.
      </p>
      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Chunk address from another device</span>
          <Input bind:value={readAddr} />
        </label>
        <Button variant="secondary" onclick={runReadByAddress} disabled={readChecking || !readAddr}>
          {readChecking ? 'Reading…' : 'Read by address'}
        </Button>
      </div>
      {#if readLog.length}
        <div class={CARD_CLASS}>
          {#each readLog as line, i (i)}
            <p class="font-mono text-sm break-all">{line}</p>
          {/each}
        </div>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Manual Sync Testing</h3>
      <p class="text-sm">
        Trigger a manual sync for ALL accounts to test postage stamp utilization tracking.
      </p>
      <div class="flex gap-4">
        <Button onclick={triggerManualSync}>Sync All Accounts</Button>
      </div>

      {#if syncMessage}
        <div class="flex flex-col gap-4 rounded-lg border bg-card p-4 whitespace-pre-wrap">
          <p class="font-mono text-sm">{syncMessage}</p>
        </div>
      {/if}

      <div class="flex flex-col gap-2">
        <p class="text-muted-foreground text-sm">Requirements for sync:</p>
        <p class="text-muted-foreground font-mono text-sm">
          • At least one account with a default postage stamp
        </p>
        <p class="text-muted-foreground font-mono text-sm">
          • Open browser console to see detailed logs
        </p>
      </div>

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Partition tuning</h3>
      <p class="text-muted-foreground text-sm">
        Tune the multi-device intent-round timing for this gateway's propagation delay. Blank =
        library default (window 12000 / poll 2500 / read 2500 ms). Reload the app after saving so
        the proxy picks it up.
      </p>
      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Guard window (ms)</span>
          <Input bind:value={tuningWindow} />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Poll interval (ms)</span>
          <Input bind:value={tuningPoll} />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Read timeout (ms)</span>
          <Input bind:value={tuningTimeout} />
        </label>
        <div class="flex items-center gap-2">
          <Button onclick={saveTuning}>Save tuning</Button>
          <Button variant="secondary" onclick={resetTuning}>Reset to defaults</Button>
        </div>
        {#if tuningSaved}
          <p class="text-muted-foreground text-sm">{tuningSaved}</p>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Chain Tab -->
  {#if activeTab === 'chain'}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-semibold">Simulated purchase</h3>
      <p class="text-muted-foreground text-sm">
        <strong>Add drive</strong> and the paid drive operations all buy for real, against whichever chain
        this page is pointed at — there is no simulated settlement any more, and no outcome to choose.
        Money always reaches the batch owner through a payment the user makes: from Gnosis directly, or
        — with a local source chain running — through the payment screens and the local solver. Nothing
        in the app settles an operation out of the faucet below; that is yours to do here, before an operation
        needs it.
      </p>

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Faucet</h3>
      <p class="text-muted-foreground text-sm">
        Hands <em>any</em> address money on either dev chain. On Gnosis that is a plain transfer from
        the faucet the bake stocked — the BZZ pool here is real and thin, and only a purchase is worth
        spending it on. The fake mainnet has no faucet to transfer from, so ETH is minted there instead;
        that is the chain a rehearsed payment is signed on, so it is the wallet account you connect with
        that needs it.
      </p>

      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Recipient</span>
          <Input bind:value={faucetTo} placeholder="0x… any address" />
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!accountSigner} onclick={fillFromSigner}>
            Use account signer
          </Button>
          <Button variant="secondary" size="sm" onclick={fillFromWallet}>
            Use connected wallet
          </Button>
          <Button variant="secondary" size="sm" onclick={() => (faucetTo = ANVIL_ACCOUNT.address)}>
            Use anvil account 0
          </Button>
          {#if faucetTo.trim() && !faucetRecipient}
            <span class="text-destructive text-sm">Not an address.</span>
          {/if}
        </div>
      </div>

      <div class={CARD_CLASS}>
        <p class="text-muted-foreground text-sm">
          <strong>Anvil account 0</strong> starts with 10 000 native on each chain — 10 000 ETH on the
          fake mainnet, 10 000 xDAI on Gnosis — and no BZZ, which is the bake faucet's to give. Pick it
          above to see that in the table. Importing its key into MetaMask is the shortcut to a wallet
          that already holds both.
        </p>
        <p class="text-muted-foreground text-sm">
          <strong>Nothing tops a wallet up during a payment.</strong> The bridged rail used to mint the
          payer 10 ETH on its way past; it no longer does, because no production rail can hand the payer
          money — and while one did, a wallet that could not afford the payment was the one state this
          could never reach. Fund the wallet you connect with here, out of band, the way a testnet faucet
          works. An empty one now fails on send, where it would live.
        </p>
        {@render copyRow('Address', ANVIL_ACCOUNT.address)}
        {@render copyRow('Private key', ANVIL_ACCOUNT.privateKey)}
      </div>

      {#if fundsError}
        <p class="text-destructive text-sm">{fundsError}</p>
      {/if}
      {#if balanceRows.length}
        <div class="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-x-4 gap-y-1 text-sm">
          <span></span>
          <span></span>
          <span class="text-muted-foreground text-right text-xs">ETH</span>
          <span class="text-muted-foreground text-right text-xs">xDAI</span>
          <span class="text-muted-foreground text-right text-xs">BZZ</span>
          {#each balanceRows as row (row.label)}
            <span class="text-muted-foreground">{row.label}</span>
            <span class="font-mono text-xs break-all">{row.address}</span>
            <span class="text-right font-mono">{row.eth}</span>
            <span class="text-right font-mono">{row.xdai}</span>
            <span class="text-right font-mono">{row.bzz}</span>
          {/each}
        </div>
      {:else}
        <p class="text-muted-foreground text-sm">Enter a recipient to see balances.</p>
      {/if}
      {#if faucetRecipient && sourceEth === undefined}
        <p class="text-muted-foreground text-xs">
          No ETH figure — nothing is answering at
          <span class="font-mono">{localSourceRpcUrl()}</span>. Start it with
          <span class="font-mono">pnpm dev:source-chain</span>.
        </p>
      {/if}

      <div class="flex flex-wrap items-end gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>ETH (fake mainnet)</span>
          <Input bind:value={faucetEth} class="w-32" />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>xDAI (Gnosis)</span>
          <Input bind:value={faucetXdai} class="w-32" />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>BZZ (Gnosis)</span>
          <Input bind:value={faucetBzz} class="w-32" />
        </label>
        <Button
          disabled={faucetBusy || !faucetRecipient || faucetLegs.length === 0}
          onclick={sendFaucetFunds}
        >
          {faucetBusy ? 'Sending…' : 'Send'}
        </Button>
        <Button variant="secondary" disabled={!faucetRecipient} onclick={refreshFunds}>
          Refresh
        </Button>
      </div>
      {#if faucetMessage}
        <p class="text-sm break-all">{faucetMessage}</p>
      {/if}
      {#if faucetError}
        <p class="text-destructive text-sm">{faucetError}</p>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Wallet networks</h3>
      <p class="text-muted-foreground text-sm">
        Adds these chains to MetaMask, so a balance shows before you reach the payment screens.
        <strong>Gnosis Chain (fake)</strong> is the one to add first — paying from it is a plain transfer
        to the batch owner, with no bridge and no solver in the way. The other is only needed to rehearse
        a bridged payment.
      </p>
      {#if walletChains.length === 0}
        <p class="text-muted-foreground text-sm">
          No payment chains resolved — is the Gnosis RPC in Network settings reachable?
        </p>
      {:else}
        <div class="flex flex-wrap items-center gap-2">
          {#each walletChains as chain (chain.id)}
            <Button variant="secondary" onclick={() => addChainToWallet(chain)}>
              Add {chain.name}
            </Button>
          {/each}
        </div>
      {/if}
      {#if walletMessage}
        <p class="font-mono text-sm">{walletMessage}</p>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">On-chain drive tooling</h3>
      <p class="text-muted-foreground text-sm">
        Extend and resize are signed by the account's derived postage signer and sent straight to
        the PostageStamp contract — no Bee node. There is no Relay locally, so
        <strong>Create owned batch</strong> stands in for the purchase, running the widget's real step
        list against the local chain's BZZ pool. It swaps rather than drawing on the faucet above: the
        purchase is the one leg worth simulating faithfully. Off mainnet the drive dialogs settle the
        same way, without opening the payment screen.
      </p>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={chainToolBusy || !selectedAccountId}
          onclick={() =>
            runChainTool(
              'Created owned batch',
              async (key) => (await createOwnedBatchOnChain(key)).batchId,
            )}
        >
          Create owned batch (depth 20)
        </Button>
        <Button
          disabled={chainToolBusy || !selectedAccountId}
          onclick={() => runChainTool('Created drive', (_key, account) => createTestDrive(account))}
        >
          Create drive to test with
        </Button>
      </div>
      <p class="text-muted-foreground text-sm">
        Acts on the account selected at the top of the page. For the normal path just use
        <em>Add drive</em> — off mainnet it creates the batch the same way. These buttons are for
        driving the chain directly: topping the signer up, or making a batch to attach by hand via
        <em>Add drive → Use existing</em>.
      </p>
      {#if chainToolMessage}
        <p class="text-sm break-all">{chainToolMessage}</p>
      {/if}
      {#if chainToolError}
        <p class="text-destructive text-sm">{chainToolError}</p>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Import batch by ID</h3>
      <p class="text-muted-foreground text-sm">
        Read a batch's parameters straight from the PostageStamp contract on-chain (not from a Bee
        node), so any batch id works even if the configured node never saw it. The signer key is not
        on-chain — paste the one the batch was bought with.
      </p>
      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Batch ID</span>
          <Input bind:value={importBatchId} placeholder="0x… (64 hex chars)" />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Signer Key</span>
          <Input bind:value={importSignerKey} placeholder="64 hex chars" />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Gnosis RPC URL</span>
          <Input bind:value={importRpcUrl} />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>PostageStamp contract</span>
          <Input bind:value={importContractOverride} placeholder={resolvedContract} />
          <span class="text-muted-foreground text-xs">
            Auto from RPC: <span class="font-mono">{resolvedContract}</span> — leave blank to use it (local
            RPC → local deployment, else Gnosis mainnet).
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={importSetDefault} />
          Set as account default
        </label>
      </div>
      <Button
        onclick={importBatchById}
        disabled={importing || !importBatchId || !importSignerKey || !selectedAccountId}
      >
        {importing ? 'Importing…' : 'Import batch'}
      </Button>
      {#if importMessage}
        <p class="text-success text-sm">{importMessage}</p>
      {/if}
      {#if importError}
        <p class="text-destructive text-sm">{importError}</p>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Signer Key / Owner Address</h3>
      <p class="text-muted-foreground text-sm">
        Buy a stamp online under the owner address, then paste the private key as the signer key in
        the "Use existing one" screen. Reflects the account selected above.
      </p>

      {#if !selectedAccountId}
        <p class="text-muted-foreground text-sm">Select an account above to view its signer key.</p>
      {:else if accountSigner}
        <div class="flex flex-col gap-2">
          {@render signerCard('Account-level signer', accountSigner)}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Devices Tab -->
  {#if activeTab === 'devices'}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-semibold">Account Devices</h3>
      <p class="text-sm">
        Inspect the devices registered to an account and which partitions they currently hold.
      </p>
      {#if selectedAccount}
        {#key selectedAccountId}
          <DeviceList account={selectedAccount} />
        {/key}
      {:else}
        <p class="text-muted-foreground text-sm">No accounts found.</p>
      {/if}
    </div>
  {/if}
</div>
