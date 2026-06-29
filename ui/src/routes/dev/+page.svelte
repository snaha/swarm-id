<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'

  import { BatchId, Bee, EthAddress, Identifier, PrivateKey, Utils } from '@ethersphere/bee-js'
  import {
    calculateStampAmountForDays,
    derivePostageSignerKey,
    downloadEncryptedSOC,
    fetchChainState,
    formatTTL,
    rejectAfter,
    uint8ArrayToHex,
    uploadSOC,
  } from '@snaha/swarm-id'

  import { resolve } from '$app/paths'

  import CopyButton from '$lib/components/copy-button.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { Tabs } from '$lib/components/ui/tabs'
  import { sharedAccountsStore } from '$lib/dev/accounts.svelte'
  import { devSettingsStore } from '$lib/dev/dev-settings.svelte'
  import { networkSettingsStore } from '$lib/dev/network-settings.svelte'
  import { postageStampsStore } from '$lib/dev/postage-stamps.svelte'
  import { triggerSync } from '$lib/dev/sync-hooks'
  import { syncStore } from '$lib/dev/sync.svelte'
  import routes from '$lib/routes'
  import { setAccountsSyncHook } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  import DeviceList from './device-list.svelte'
  import StatusDot from './status-dot.svelte'

  // Dev tooling drives Swarm publishing: register the sync hook while this page
  // is mounted so account mutations (here and in child panels) publish to Swarm
  // after a debounce — and reset it on unmount so the product UI stops
  // publishing once the user navigates away from /dev.
  onMount(() => {
    setAccountsSyncHook(triggerSync)
    return () => setAccountsSyncHook(undefined)
  })

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
  // deletion can propagate, so list only the live drives.
  const allStamps = $derived(sharedAccountsStore.accounts.flatMap((a) => a.drives))

  // Same set, but carrying the owning account — the Stored Stamps list needs the
  // account id to delete a stamp from its nested collection.
  const storedStampRows = $derived(
    sharedAccountsStore.accounts.flatMap((a) =>
      a.drives.map((stamp) => ({ accountId: a.id, accountName: a.name, stamp })),
    ),
  )
  let storedStampMessage = $state('')

  // Delete a single stored stamp (dev cleanup — replaces the old hand-edit of
  // localStorage). `removeDrive` tombstones the stamp (`deletedAt`) and lets the
  // deletion sync: `mergePostageStamps` keeps the tombstone (#337), so a peer's
  // fold no longer resurrects it.
  function deleteStoredStamp(accountId: EthAddress, batchID: BatchId) {
    sharedAccountsStore.getAccount(accountId)?.removeDrive(batchID)
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

  // Stamp buying state
  let beeUrl = $state('http://localhost:1633')
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
      ? sharedAccountsStore.getAccount(new EthAddress(selectedAccountId))
      : undefined
    if (!acct) {
      accountSigner = undefined
      return
    }
    // ponytail: fire-and-forget derive; effect re-runs when the selection changes
    void (async () => {
      const k = await derivePostageSignerKey(acct.derivationKey)
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
      // Test the node the proxy/app actually uses (network settings), not the
      // dev-page stamp-buying URL which defaults to localhost.
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
  let customSignerError = $state<string | undefined>(undefined)

  // Mock stamp widget settings — the store is the single source of truth
  // (durable + cross-tab); the controls below read/write it directly.

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
    sharedAccountsStore.accounts.map((account) => ({
      value: account.id.toHex(),
      label: `${account.name} (${account.id.toHex().slice(0, 10)}…)`,
    })),
  )
  const selectedAccount = $derived(
    selectedAccountId
      ? sharedAccountsStore.getAccount(new EthAddress(selectedAccountId))
      : undefined,
  )
  const accountHasDefaultDrive = $derived(!!selectedAccount?.defaultPostageStampBatchID)
  const driveAssignments = $derived(
    (() => {
      const map = new SvelteMap<string, { account?: string }>()
      for (const account of sharedAccountsStore.accounts) {
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
    const accountsToSync = sharedAccountsStore.accounts.filter(
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
      const response = await fetch(`${beeUrl}/stamps/${stampAmount}/${stampDepth}`, {
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

  // Clear this browser's accounts (which own their apps + stamps) + session.
  function clearAccount() {
    sharedAccountsStore.clear()
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
    beeStampsLoading = true
    beeStampsError = ''
    try {
      const response = await fetch(`${beeUrl}/stamps`)
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || `HTTP ${response.status}`)
      }
      const data = await response.json()
      beeStamps = data.stamps ?? []
      lastBeeUrl = beeUrl
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
      const state = await fetchChainState(beeUrl)
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
    if (activeTab === 'stamps' && beeUrl && beeUrl !== lastBeeUrl && !beeStampsLoading) {
      loadBeeStamps()
      loadChainState()
    }
  })

  function assignAccountDrive() {
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
      const account = sharedAccountsStore.getAccount(accountId)
      if (!account) {
        assignError = 'Account not found.'
        return
      }

      // Determine which signer key to use
      const signerKeyToUse =
        useCustomSigner && customSignerKey
          ? new PrivateKey(customSignerKey)
          : new PrivateKey(selectedSigner)

      if (!postageStampsStore.getStamp(batchId)) {
        const beeStamp = beeStamps.find((s) => s.batchID === selectedStampId)
        if (!beeStamp) {
          assignError = 'Stamp data not found. Reload stamps first.'
          return
        }
        account.addDrive({
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
        })
      } else if (useCustomSigner) {
        const beeStamp = postageStampsStore.getStamp(batchId)
        if (!beeStamp) {
          assignError = 'Stamp not found in local storage.'
          return
        }
        // Compare by value — `signerKey` is a bee-js PrivateKey, so `!==` would
        // always be true (distinct instances) and re-add the drive needlessly.
        if (!beeStamp.signerKey.equals(signerKeyToUse)) {
          account.removeDrive(batchId)
          account.addDrive({ ...beeStamp, signerKey: signerKeyToUse })
        }
      }

      account.setDefaultDrive(batchId)
      assignMessage = `✅ Set account drive for ${accountId.toHex().slice(0, 8)}…`
    } catch (error) {
      assignError = error instanceof Error ? error.message : String(error)
    }
  }

  // Clears the account's DEFAULT-drive pointer only; the stamp stays in the
  // account's drives (delete it outright in "Stored Stamps" above). Assign is
  // the symmetric op — it sets the default.
  function clearDefaultDrive() {
    assignError = ''
    assignMessage = ''
    if (!selectedAccountId) {
      assignError = 'Select an account first.'
      return
    }
    const accountId = new EthAddress(selectedAccountId)
    sharedAccountsStore.getAccount(accountId)?.setDefaultDrive(undefined)
    assignMessage = `✅ Cleared default drive for ${selectedAccountId.slice(0, 8)}…`
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
    {@const accountCount = sharedAccountsStore.accounts.length}
    {@const connectionCount = sharedAccountsStore.accounts.reduce(
      (n, a) => n + a.connectedApps.length,
      0,
    )}
    {@const driveCount = allStamps.length}
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
          {accountCount} accounts, {connectionCount} connections, {driveCount} drives
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
      <!-- Mock Stamp Widget Settings -->
      <div class="flex flex-col gap-2">
        <h3 class="text-lg font-semibold">Mock Stamp Widget</h3>
        <p class="text-sm">Control the behavior of the stamp purchase widget in the app.</p>

        <div class="flex items-center gap-4">
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={devSettingsStore.data.mockStampEnabled}
              onchange={(e) => devSettingsStore.setMockStampEnabled(e.currentTarget.checked)}
            />
            Enable mock mode
          </label>
        </div>

        {#if devSettingsStore.data.mockStampEnabled}
          <div class="flex items-center gap-4">
            <span class="text-sm">Mock result:</span>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                checked={devSettingsStore.data.mockStampResult === 'success'}
                onchange={() => devSettingsStore.setMockStampResult('success')}
              />
              Success
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                checked={devSettingsStore.data.mockStampResult === 'error'}
                onchange={() => devSettingsStore.setMockStampResult('error')}
              />
              Error
            </label>
          </div>
        {/if}
      </div>

      <div class="bg-border my-4 h-px"></div>

      <h3 class="text-lg font-semibold">Buy Postage Stamp</h3>
      <p class="text-sm">Buy a postage stamp on the local blockchain for testing uploads.</p>

      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Bee Node URL</span>
          <Input bind:value={beeUrl} />
        </label>
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
        Writes a throwaway single-owner chunk to the Bee node from network settings ({networkSettingsStore.beeNodeUrl})
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
            {@const assignment = driveAssignments.get(stamp.batchID)}
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

      <h3 class="text-lg font-semibold">Assign drive to account</h3>
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
      </div>

      <div class="flex items-center gap-2">
        <Button onclick={assignAccountDrive} disabled={!selectedStampId || !selectedAccountId}>
          Set account drive
        </Button>
        <Button
          variant="destructive"
          onclick={clearDefaultDrive}
          disabled={!accountHasDefaultDrive}
        >
          Clear default drive
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
