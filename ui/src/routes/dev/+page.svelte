<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'

  import { BatchId, Bee, EthAddress, Identifier, PrivateKey, Utils } from '@ethersphere/bee-js'
  import {
    calculateStampAmountForDays,
    derivePostageSignerKey,
    downloadEncryptedSOC,
    fetchChainState,
    formatTTL,
    rejectAfter,
    resolvePostageStampContractAddress,
    uint8ArrayToHex,
    uploadSOC,
  } from '@snaha/swarm-id'

  import { resolve } from '$app/paths'

  import CopyButton from '$lib/components/copy-button.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { Tabs } from '$lib/components/ui/tabs'
  import { postageStampsStore } from '$lib/dev/postage-stamps.svelte'
  import { syncStore } from '$lib/dev/sync.svelte'
  import { fetchExistingBatchFromChain } from '$lib/payment/contract'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  import DeviceList from './device-list.svelte'
  import StatusDot from './status-dot.svelte'

  // The Swarm publish hook is now installed app-wide in the root layout
  // (`+layout.svelte`), so /dev no longer manages it — a local install +
  // unmount cleanup here would toggle publishing off for the whole app on
  // navigating away.

  // Milliseconds per second — for converting TTL/Unix seconds to JS `Date` ms.
  const MS_PER_SECOND = 1000

  // How many days of validity to fund by default when auto-filling the
  // stamp amount from current chain price. Bee enforces a 24h minimum on
  // POST /stamps; 7 days gives comfortable headroom for dev testing without
  // re-buying constantly.
  const DEFAULT_STAMP_DAYS = 7

  // Renders a listed stamp's remaining lifetime as "<ttl> (<date>)". batchTTL
  // comes straight from the Bee node's /stamps response — authoritative for the
  // batches it tracks, which is exactly what this list shows (no contract read
  // needed here, and the default chain is local where the mainnet PostageStamp
  // contract isn't deployed).
  function formatStampExpiry(batchTTL: number): string {
    if (!batchTTL || batchTTL <= 0) return 'Expired'
    const date = new Date(Date.now() + batchTTL * MS_PER_SECOND).toLocaleDateString()
    return `${formatTTL(batchTTL)} (${date})`
  }

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
    { value: 'stamps', label: 'Stamps' },
    { value: 'sync', label: 'Sync' },
    { value: 'devices', label: 'Devices' },
  ]

  // Demo app URL for connect flow testing (the new UI's demo runs on :3500).
  const demoAppOrigin = 'http://localhost:3500'

  // Sync state
  let syncMessage = $state('')

  // Stamp buying state. The Bee node URL is NOT page-local: every dev
  // subsystem (stamp buying/listing here, sync, account refresh, the
  // retrievability checks) reads the one persisted network setting, so a URL
  // change applies everywhere at once — buying a stamp against one node while
  // sync silently targets another was a debugging trap.
  // Amount starts empty — autofilled from chain price on first chainstate
  // load (see loadChainState). Hardcoding a default is fragile across chain
  // configs: bee-compose's PriceOracle floor (24_000 PLUR/chunk/block) needs
  // ≥ 414_720_000 PLUR/chunk for 24h, and other chains have different floors.
  let stampAmount = $state('')
  let stampDepth = $state('20')
  let buying = $state(false)
  let stampResult = $state<{ batchID: string; txHash: string } | undefined>(undefined)
  let stampError = $state('')
  let currentPrice = $state<bigint | undefined>(undefined)
  let chainStateError = $state('')
  let assignMessage = $state('')
  let assignError = $state('')
  let selectedStampId = $state('')
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
  let beeStamps = $state<
    Array<{
      batchID: string
      utilization: number
      usable: boolean
      label: string
      depth: number
      amount: string
      bucketDepth: number
      blockNumber: number
      immutableFlag: boolean
      exists: boolean
      batchTTL: number
    }>
  >([])
  let beeStampsLoading = $state(false)
  let beeStampsError = $state('')
  let lastBeeUrl = $state('')

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

  // Known dev signers (pre-funded with ETH + BZZ in the local Bee cluster)
  const KNOWN_SIGNERS = [
    {
      value: '566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9',
      label: 'Queen (node owner)',
    },
    {
      value: '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
      label: 'Wallet 0 (pre-funded)',
    },
    {
      value: '6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1',
      label: 'Wallet 1 (pre-funded)',
    },
  ]
  let selectedSigner = $state(KNOWN_SIGNERS[0].value)

  // Custom signer key settings
  let useCustomSigner = $state(false)
  let customSignerKey = $state('')
  // Unchecked = stack the batch onto the account WITHOUT stealing the default
  // pointer, so an account can hold multiple drives.
  let assignSetDefault = $state(true)
  let customSignerError = $state<string | undefined>(undefined)

  // Mock stamp widget settings — `devSettingsStore` is the single source of
  // truth (durable + cross-tab); the controls bind straight to its setters via
  // function bindings, so there is no local mirror to drift.
  const MOCK_RESULT_OPTIONS = [
    { value: 'success', label: 'Success (creates a drive)' },
    { value: 'error', label: 'Error (purchase failed)' },
  ]

  // Validate custom signer key when enabled
  $effect(() => {
    if (useCustomSigner) {
      if (customSignerKey.length === 0) {
        customSignerError = 'Custom signer key is required'
      } else if (!/^[0-9a-fA-F]+$/.test(customSignerKey)) {
        customSignerError = 'Signer key must be a valid hex string'
      } else if (customSignerKey.length !== 64) {
        customSignerError = 'Signer key must be exactly 64 characters (hex)'
      } else {
        customSignerError = undefined
      }
    } else {
      customSignerError = undefined
    }
  })

  const stampOptions = $derived(
    beeStamps.map((stamp) => ({
      value: stamp.batchID,
      label: `${stamp.batchID.slice(0, 10)}… (depth ${stamp.depth})`,
    })),
  )
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
  const accountHasDefaultStamp = $derived(!!selectedAccount?.defaultPostageStampBatchID)
  const stampAssignments = $derived(
    (() => {
      const map = new SvelteMap<string, { account?: string }>()
      for (const account of accountsStore.accounts) {
        const batch = account.defaultPostageStampBatchID?.toHex()
        if (batch) {
          map.set(batch, { ...(map.get(batch) ?? {}), account: account.name })
        }
      }
      return map
    })(),
  )

  $effect(() => {
    if (stampOptions.length && !selectedStampId) {
      selectedStampId = stampOptions[0].value
    } else if (
      selectedStampId &&
      !stampOptions.some((option) => option.value === selectedStampId)
    ) {
      selectedStampId = stampOptions[0]?.value ?? ''
    }
  })

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

  async function buyStamp() {
    buying = true
    stampError = ''
    stampResult = undefined

    try {
      // Buy a MUTABLE batch. Bee's POST /stamps defaults to immutable, but the
      // multi-device partition scheme rewrites the partition-lock SOC on every
      // lease refresh, which an immutable batch forbids. Request mutable
      // explicitly so /dev-bought stamps work with partitioning.
      // Tolerate a trailing slash (the default gateway URL has one).
      const base = networkSettingsStore.beeNodeUrl.replace(/\/$/, '')
      const response = await fetch(`${base}/stamps/${stampAmount}/${stampDepth}`, {
        method: 'POST',
        headers: { immutable: 'false' },
      })
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || `HTTP ${response.status}`)
      }
      stampResult = await response.json()
    } catch (e) {
      stampError = e instanceof Error ? e.message : String(e)
    } finally {
      buying = false
    }
  }

  // Import a batch by ID, reading its parameters from the PostageStamp contract
  // ON-CHAIN (not from a Bee node) — works for any batch id even when the
  // configured node never saw it. The signer key is NOT on-chain, so the user
  // supplies it (required to sign uploads with the batch). The local anvil
  // deployment address is shared from `$lib/payment/contract`.

  let importBatchId = $state('')
  let importSignerKey = $state('')
  let importRpcUrl = $state('http://localhost:9545')
  // Blank → auto-detect from the RPC (local vs Gnosis mainnet); a value overrides.
  let importContractOverride = $state('')
  let importSetDefault = $state(true)
  let importing = $state(false)
  let importMessage = $state('')
  let importError = $state('')

  // Contract address the read will use: the override if set, else auto-detected
  // from the RPC. There is no local-only deployment any more: the cluster's
  // chain carries the Swarm contracts at their MAINNET addresses, so local and
  // remote resolve to the same one.
  const resolvedContract = $derived(resolvePostageStampContractAddress(importRpcUrl.trim()))
  const effectiveContract = $derived(importContractOverride.trim() || resolvedContract)

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
        contractAddress: effectiveContract,
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
  function clearAccount() {
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

  async function loadBeeStamps() {
    const url = networkSettingsStore.beeNodeUrl
    // Record the attempt BEFORE fetching — success or failure. The auto-load
    // effect is guarded by `url !== lastBeeUrl`; recording only on success made
    // every failure re-arm the effect, hammering an unreachable node in a loop.
    lastBeeUrl = url
    beeStampsLoading = true
    beeStampsError = ''
    try {
      // Tolerate a trailing slash (the default gateway URL has one);
      // `lastBeeUrl` keeps the raw value so the effect's guard compares equal.
      const response = await fetch(`${url.replace(/\/$/, '')}/stamps`)
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || `HTTP ${response.status}`)
      }
      const data = await response.json()
      beeStamps = data.stamps ?? []
    } catch (error) {
      beeStampsError = error instanceof Error ? error.message : String(error)
      beeStamps = []
    } finally {
      beeStampsLoading = false
    }
  }

  async function loadChainState() {
    chainStateError = ''
    try {
      const state = await fetchChainState(networkSettingsStore.beeNodeUrl)
      currentPrice = state.currentPrice
      // Only autofill if the user hasn't typed (or pre-typed) a value yet.
      // After the first fill, the user owns this field — switching bee URLs
      // updates the displayed price but does not clobber their input.
      if (stampAmount === '') {
        stampAmount = calculateStampAmountForDays(state.currentPrice, DEFAULT_STAMP_DAYS).toString()
      }
    } catch (error) {
      chainStateError = error instanceof Error ? error.message : String(error)
      currentPrice = undefined
    }
  }

  $effect(() => {
    const url = networkSettingsStore.beeNodeUrl
    if (activeTab === 'stamps' && url && url !== lastBeeUrl && !beeStampsLoading) {
      loadBeeStamps()
      loadChainState()
    }
  })

  function assignAccountStamp() {
    assignError = ''
    assignMessage = ''
    if (!selectedStampId || !selectedAccountId) {
      assignError = 'Select a stamp and an account first.'
      return
    }

    // Validate custom signer if enabled
    if (useCustomSigner && customSignerError) {
      assignError = customSignerError
      return
    }

    try {
      const batchId = new BatchId(selectedStampId)
      const accountId = new EthAddress(selectedAccountId)
      const account = accountsStore.getAccount(accountId)
      if (!account) {
        assignError = 'Account not found.'
        return
      }

      // Determine which signer key to use
      const signerKeyToUse =
        useCustomSigner && customSignerKey
          ? new PrivateKey(customSignerKey)
          : new PrivateKey(selectedSigner)

      // Existence is per-ACCOUNT (`hasLiveStamp`), not the cross-account
      // runtime view: a batch already owned by another account must still be
      // added to THIS one, else only the default pointer would move and dangle
      // at a batch the account doesn't own.
      if (!account.hasLiveStamp(batchId)) {
        // Stamp data source: another account's live copy, or the node list.
        const stored = postageStampsStore.getStamp(batchId)
        const beeStamp = beeStamps.find((s) => s.batchID === selectedStampId)
        if (stored) {
          account.addStamp({ ...stored, signerKey: signerKeyToUse })
        } else if (beeStamp) {
          account.addStamp({
            batchID: batchId,
            signerKey: signerKeyToUse,
            utilization: Utils.getStampUsage(
              beeStamp.utilization,
              beeStamp.depth,
              beeStamp.bucketDepth,
            ),
            usable: beeStamp.usable,
            depth: beeStamp.depth,
            amount: BigInt(beeStamp.amount),
            bucketDepth: beeStamp.bucketDepth,
            blockNumber: beeStamp.blockNumber,
            immutableFlag: beeStamp.immutableFlag,
            exists: beeStamp.exists,
            // Without this the drive card's Lifespan section has nothing to
            // show — the node listing knows the remaining TTL.
            batchTTL: beeStamp.batchTTL,
          })
        } else {
          assignError = 'Stamp data not found. Reload stamps first.'
          return
        }
      } else if (useCustomSigner) {
        const owned = account.stamps.find((s) => s.batchID.equals(batchId))
        if (!owned) {
          assignError = 'Stamp not found on the account.'
          return
        }
        // Compare by value — `signerKey` is a bee-js PrivateKey, so `!==` would
        // always be true (distinct instances) and re-add the stamp needlessly.
        if (!owned.signerKey.equals(signerKeyToUse)) {
          account.removeStamp(batchId)
          account.addStamp({ ...owned, signerKey: signerKeyToUse })
        }
      }

      if (assignSetDefault) {
        account.setDefaultStamp(batchId)
        assignMessage = `✅ Set account stamp for ${accountId.toHex().slice(0, 8)}…`
      } else {
        assignMessage = `✅ Added stamp to ${accountId.toHex().slice(0, 8)}…`
      }
    } catch (error) {
      assignError = error instanceof Error ? error.message : String(error)
    }
  }

  // Clears the account's DEFAULT-stamp pointer only; the stamp stays in the
  // account's stamps (delete it outright in "Stored Stamps" above). Assign is
  // the symmetric op — it sets the default.
  function clearDefaultStamp() {
    assignError = ''
    assignMessage = ''
    if (!selectedAccountId) {
      assignError = 'Select an account first.'
      return
    }
    const accountId = new EthAddress(selectedAccountId)
    accountsStore.getAccount(accountId)?.setDefaultStamp(undefined)
    assignMessage = `✅ Cleared default stamp for ${selectedAccountId.slice(0, 8)}…`
  }

  const LABEL_CLASS = 'flex flex-col gap-1.5 text-sm'
  const LABEL_TEXT_CLASS = 'text-muted-foreground'
  const CARD_CLASS = 'flex flex-col gap-2 rounded-lg border bg-card p-4'
</script>

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

  <Tabs {tabs} bind:value={activeTab} />

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
        <div class="flex items-center gap-2">
          <StatusDot endpoint="http://localhost:1633" />
          <span class="font-mono text-sm">Queen API:</span>
          <a
            href="http://localhost:1633"
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">http://localhost:1633</a
          >
          <CopyButton text="http://localhost:1633" />
        </div>
        <div class="flex items-center gap-2">
          <StatusDot endpoint="http://localhost:16331" />
          <span class="font-mono text-sm">Worker API:</span>
          <a
            href="http://localhost:16331"
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">http://localhost:16331</a
          >
          <CopyButton text="http://localhost:16331" />
        </div>
        <div class="flex items-center gap-2">
          <StatusDot endpoint="http://localhost:9545" method="json-rpc" />
          <span class="font-mono text-sm">Blockchain RPC:</span>
          <a
            href="http://localhost:9545"
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">http://localhost:9545</a
          >
          <CopyButton text="http://localhost:9545" />
        </div>
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
          <Button variant="destructive" onclick={clearAccount}>Clear account</Button>
          <Button variant="destructive" onclick={clearAll}>Clear all</Button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Stamps Tab -->
  {#if activeTab === 'stamps'}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-semibold">Mock stamp purchase</h3>
      <p class="text-muted-foreground text-sm">
        Simulate the product <strong>Add drive</strong> flow (Storage tab / Upgrade) without a real cross-chain
        payment. When enabled, the purchase widget resolves locally after a short delay.
      </p>
      <label class="flex items-center gap-2">
        <Switch
          bind:checked={
            () => devSettingsStore.data.mockStampEnabled,
            (enabled) => devSettingsStore.setMockStampEnabled(enabled)
          }
          aria-label="Enable mock stamp purchase"
        />
        <span class="text-sm">Enable mock purchases</span>
      </label>
      {#if devSettingsStore.data.mockStampEnabled}
        <label class="flex items-center gap-2">
          <Switch
            bind:checked={
              () => devSettingsStore.data.mockStampPopup,
              (popup) => devSettingsStore.setMockStampPopup(popup)
            }
            aria-label="Open widget popup while mocking"
          />
          <span class="text-sm"
            >Open widget popup (off = local, works where popups are blocked)</span
          >
        </label>
        <label class={`${LABEL_CLASS} w-64`}>
          <span class={LABEL_TEXT_CLASS}>Outcome</span>
          <Select
            options={MOCK_RESULT_OPTIONS}
            bind:value={
              () => devSettingsStore.data.mockStampResult,
              (result) =>
                devSettingsStore.setMockStampResult(result === 'error' ? 'error' : 'success')
            }
          />
        </label>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Buy Postage Stamp</h3>
      <p class="text-sm">Buy a postage stamp on the local blockchain for testing uploads.</p>

      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Bee Node URL (network settings)</span>
          <div class="flex gap-2">
            <Input bind:value={networkSettingsStore.beeNodeUrl} />
            <Button variant="secondary" onclick={networkSettingsStore.reset}>Reset</Button>
          </div>
        </label>
        <p class="text-muted-foreground text-sm">
          One URL for all dev tooling — stamp buying/listing here, plus sync, account refresh and
          the retrievability checks below. Persisted across reloads; point it at
          http://localhost:1633 for the local cluster.
        </p>
        <div class="flex gap-4">
          <label class={`${LABEL_CLASS} flex-1`}>
            <span class={LABEL_TEXT_CLASS}>Amount</span>
            <Input bind:value={stampAmount} />
          </label>
          <label class={`${LABEL_CLASS} w-32`}>
            <span class={LABEL_TEXT_CLASS}>Depth (17-40)</span>
            <Input bind:value={stampDepth} />
          </label>
        </div>
        {#if currentPrice !== undefined}
          {@const minAmount = calculateStampAmountForDays(currentPrice, 1)}
          <p class="text-muted-foreground text-sm">
            Chain price: {currentPrice.toLocaleString()} PLUR/chunk/block · 24h min: {minAmount.toLocaleString()}
            PLUR · default fills {DEFAULT_STAMP_DAYS}d validity
          </p>
        {:else if chainStateError}
          <p class="text-destructive text-sm">
            Could not fetch chainstate from Bee: {chainStateError}
          </p>
        {/if}
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Signer Key</span>
          <Select options={KNOWN_SIGNERS} bind:value={selectedSigner} />
        </label>
      </div>

      <Button onclick={buyStamp} disabled={buying || !stampAmount}>
        {buying ? 'Buying...' : 'Buy Stamp'}
      </Button>

      {#if stampResult}
        {@const batchId = stampResult.batchID}
        {@const txHash = stampResult.txHash}
        <div class={CARD_CLASS}>
          <p class="font-mono text-sm font-semibold">✅ Stamp purchased!</p>
          {@render copyRow('Batch ID', batchId)}
          <div class="flex gap-8">
            {@render copyRow('Amount', stampAmount)}
            {@render copyRow('Depth', stampDepth)}
          </div>
          {@render copyRow('Signer Key (for Stamper)', selectedSigner)}
          {@render copyRow('Tx Hash', txHash)}
          <p class="text-muted-foreground mt-2 text-sm">
            Note: Wait ~30s for stamp to become usable.
          </p>
        </div>
      {/if}

      {#if stampError}
        <div class={CARD_CLASS}>
          <p class="text-destructive font-mono text-sm">❌ {stampError}</p>
        </div>
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
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Account</span>
          <Select options={accountOptions} bind:value={selectedAccountId} />
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

      <div class="bg-border my-4 h-px"></div>

      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">Existing Stamps (Bee Node)</h3>
        <Button variant="secondary" onclick={loadBeeStamps} disabled={beeStampsLoading}>
          {beeStampsLoading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>
      {#if beeStampsError}
        <p class="text-destructive text-sm">❌ {beeStampsError}</p>
      {/if}
      {#if beeStamps.length === 0}
        <p class="text-muted-foreground text-sm">No stamps found on the Bee node.</p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each beeStamps as stamp (stamp.batchID)}
            {@const assignment = stampAssignments.get(stamp.batchID)}
            <div class="flex flex-col gap-2 rounded-lg border bg-card p-4">
              <div class="flex items-center justify-between">
                <p class="font-mono text-sm">{stamp.batchID}</p>
                <CopyButton text={stamp.batchID} />
              </div>
              <div class="text-muted-foreground flex flex-wrap gap-2 text-sm">
                <span>Depth: {stamp.depth}</span>
                <span>Utilization: {stamp.utilization}</span>
                <span>Expires: {formatStampExpiry(stamp.batchTTL)}</span>
                <span>Account: {assignment?.account ?? '—'}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Assign stamp to account</h3>
      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Stamp</span>
          <Select options={stampOptions} bind:value={selectedStampId} />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Account</span>
          <Select options={accountOptions} bind:value={selectedAccountId} />
        </label>

        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={useCustomSigner} />
          Use custom signer key
        </label>

        {#if useCustomSigner}
          <label class={LABEL_CLASS}>
            <span class={LABEL_TEXT_CLASS}>Custom Signer Key</span>
            <Input bind:value={customSignerKey} aria-invalid={!!customSignerError} />
            {#if customSignerError}
              <span class="text-destructive text-xs">{customSignerError}</span>
            {/if}
          </label>
        {/if}

        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={assignSetDefault} />
          Set as account default
        </label>
      </div>

      <div class="flex items-center gap-2">
        <Button onclick={assignAccountStamp} disabled={!selectedStampId || !selectedAccountId}>
          {assignSetDefault ? 'Set account stamp' : 'Add stamp to account'}
        </Button>
        <Button
          variant="destructive"
          onclick={clearDefaultStamp}
          disabled={!accountHasDefaultStamp}
        >
          Clear default stamp
        </Button>
      </div>

      {#if assignMessage}
        <p class="text-success text-sm">{assignMessage}</p>
      {/if}
      {#if assignError}
        <p class="text-destructive text-sm">{assignError}</p>
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

  <!-- Sync Tab -->
  {#if activeTab === 'sync'}
    <div class="flex flex-col gap-4">
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
    </div>
  {/if}

  <!-- Devices Tab -->
  {#if activeTab === 'devices'}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-semibold">Account Devices</h3>
      <p class="text-sm">
        Inspect the devices registered to an account and which partitions they currently hold.
      </p>
      <label class={LABEL_CLASS}>
        <span class={LABEL_TEXT_CLASS}>Account</span>
        <Select options={accountOptions} bind:value={selectedAccountId} />
      </label>
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
