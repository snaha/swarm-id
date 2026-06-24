<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { resolve } from '$app/paths'
  import Button from '$lib/components/ui/button.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import Select from '$lib/components/ui/select/select.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { syncStore } from '$lib/stores/sync.svelte'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
  import Tabs from './tabs.svelte'
  import CopyButton from './copy-button.svelte'
  import StatusDot from './status-dot.svelte'
  import DeviceList from './device-list.svelte'
  import Divider from '$lib/components/ui/divider.svelte'
  import routes from '$lib/routes'
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
  import { MS_PER_SECOND } from '$lib/constants'
  import { SvelteMap } from 'svelte/reactivity'

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

  // Every (non-deleted) stamp across all accounts (the account owns its stamps now).
  const allStamps = $derived(
    accountsStore.accounts.flatMap((a) => a.postageStamps.filter((s) => !s.deletedAt)),
  )

  // Same set, but carrying the owning account — the Stored Stamps list needs the
  // account id to delete a stamp from its nested collection.
  const storedStampRows = $derived(
    accountsStore.accounts.flatMap((a) =>
      a.postageStamps
        .filter((stamp) => !stamp.deletedAt)
        .map((stamp) => ({ accountId: a.id, accountName: a.name, stamp })),
    ),
  )
  let storedStampMessage = $state('')

  // Delete a single stored stamp. Now a real synced delete: `removeStamp` writes
  // a `deletedAt` tombstone (#337) and we publish it, so the removal propagates
  // to other devices instead of a peer's merge re-adding it.
  function deleteStoredStamp(accountId: EthAddress, batchID: BatchId) {
    accountsStore.removeStamp(accountId, batchID)
    storedStampMessage = `🗑️ Deleted ${batchID.toHex().slice(0, 12)}…`
  }

  // Tab state
  type Tab = 'overview' | 'stamps' | 'sync' | 'devices'
  let activeTab = $state<Tab>('overview')

  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'stamps', label: 'Stamps' },
    { value: 'sync', label: 'Sync' },
    { value: 'devices', label: 'Devices' },
  ] as const

  // Demo app URL for connect flow testing
  const demoAppOrigin = 'http://localhost:3000'

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
  let selectedStampId = $state<string | undefined>(undefined)
  let selectedAccountId = $state<string | undefined>(undefined)

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
  let selfCheckStampId = $state<string | undefined>(undefined)
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
      selectedStampId = stampOptions[0]?.value
    }
  })

  $effect(() => {
    if (accountOptions.length && !selectedAccountId) {
      selectedAccountId = accountOptions[0].value
    } else if (
      selectedAccountId &&
      !accountOptions.some((option) => option.value === selectedAccountId)
    ) {
      selectedAccountId = accountOptions[0]?.value
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

  // Clear this browser's accounts (which own their apps + stamps).
  function clearAccount() {
    accountsStore.clear()
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
        accountsStore.addStamp(accountId, {
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
        if (beeStamp.signerKey !== signerKeyToUse) {
          accountsStore.removeStamp(accountId, batchId)
          accountsStore.addStamp(accountId, { ...beeStamp, signerKey: signerKeyToUse })
        }
      }

      accountsStore.setDefaultStamp(accountId, batchId)
      assignMessage = `✅ Set account stamp for ${accountId.toHex().slice(0, 8)}…`
    } catch (error) {
      assignError = error instanceof Error ? error.message : String(error)
    }
  }

  function removeAccountStamp() {
    assignError = ''
    assignMessage = ''
    if (!selectedAccountId) {
      assignError = 'Select an account first.'
      return
    }
    accountsStore.setDefaultStamp(new EthAddress(selectedAccountId), undefined)
    assignMessage = `✅ Removed account stamp from ${selectedAccountId.slice(0, 8)}…`
  }
</script>

{#snippet signerCard(label: string, signer: { privateKey: string; owner: string })}
  <Vertical
    --vertical-gap="var(--half-padding)"
    style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
  >
    <Typography font="mono">{label}</Typography>
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography variant="small" style="color: var(--colors-medium);">Owner Address</Typography>
      <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
        <Typography font="mono" variant="small" style="word-break: break-all;"
          >{signer.owner}</Typography
        >
        <CopyButton text={signer.owner} />
      </Horizontal>
    </Vertical>
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography variant="small" style="color: var(--colors-medium);">Private Key</Typography>
      <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
        <Typography font="mono" variant="small" style="word-break: break-all;"
          >{signer.privateKey}</Typography
        >
        <CopyButton text={signer.privateKey} />
      </Horizontal>
    </Vertical>
  </Vertical>
{/snippet}

<Vertical
  --vertical-gap="var(--double-padding)"
  style="max-width: 800px; padding: var(--double-padding);"
>
  <Typography variant="h2">Developer Tools</Typography>

  <Tabs {tabs} bind:active={activeTab} />

  <!-- Overview Tab -->
  {#if activeTab === 'overview'}
    {@const accountCount = accountsStore.accounts.length}
    {@const connectionCount = accountsStore.accounts.reduce(
      (n, a) => n + a.connectedApps.length,
      0,
    )}
    {@const stampCount = allStamps.length}
    <Vertical --vertical-gap="var(--padding)">
      <Vertical --vertical-gap="var(--half-padding)">
        <Typography variant="h4">Local Bee Endpoints</Typography>
        <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
          <StatusDot endpoint="http://localhost:1633" />
          <Typography variant="small" font="mono">Queen API:</Typography>
          <a href="http://localhost:1633" target="_blank" rel="noopener">
            <Typography variant="small" font="mono" style="color: var(--colors-link);"
              >http://localhost:1633</Typography
            >
          </a>
          <CopyButton text="http://localhost:1633" />
        </Horizontal>
        <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
          <StatusDot endpoint="http://localhost:16331" />
          <Typography variant="small" font="mono">Worker API:</Typography>
          <a href="http://localhost:16331" target="_blank" rel="noopener">
            <Typography variant="small" font="mono" style="color: var(--colors-link);"
              >http://localhost:16331</Typography
            >
          </a>
          <CopyButton text="http://localhost:16331" />
        </Horizontal>
        <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
          <StatusDot endpoint="http://localhost:9545" method="json-rpc" />
          <Typography variant="small" font="mono">Blockchain RPC:</Typography>
          <a href="http://localhost:9545" target="_blank" rel="noopener">
            <Typography variant="small" font="mono" style="color: var(--colors-link);"
              >http://localhost:9545</Typography
            >
          </a>
          <CopyButton text="http://localhost:9545" />
        </Horizontal>
      </Vertical>

      <Vertical --vertical-gap="var(--half-padding)">
        <Typography variant="h4">Test Connect Flow</Typography>
        <Typography variant="small">Test the connect flow with the demo app:</Typography>
        {@const connectUrl = `${resolve(routes.CONNECT)}?origin=${encodeURIComponent(demoAppOrigin)}`}
        <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
          <StatusDot endpoint={demoAppOrigin} />
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- template literal with resolve() -->
          <a href={connectUrl}>
            <Typography variant="small" font="mono" style="color: var(--colors-link);"
              >localhost:3000 (demo)</Typography
            >
          </a>
          <CopyButton text={connectUrl} />
        </Horizontal>
      </Vertical>

      <Vertical --vertical-gap="var(--half-padding)" --vertical-align-items="start">
        <Typography variant="h4">Local Data</Typography>
        <Typography>
          {accountCount} accounts, {connectionCount} connections, {stampCount}
          stamps
        </Typography>
        <Horizontal --horizontal-gap="var(--half-padding)">
          <Button variant="secondary" danger onclick={clearAccount}>Clear account</Button>
          <Button variant="secondary" danger onclick={clearAll}>Clear all</Button>
        </Horizontal>
      </Vertical>
    </Vertical>
  {/if}

  <!-- Stamps Tab -->
  {#if activeTab === 'stamps'}
    <Vertical --vertical-gap="var(--padding)">
      <!-- Mock Stamp Widget Settings -->
      <Vertical --vertical-gap="var(--half-padding)">
        <Typography variant="h3">Mock Stamp Widget</Typography>
        <Typography variant="small">
          Control the behavior of the stamp purchase widget in the app.
        </Typography>

        <Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
          <label class="checkbox-label">
            <input
              type="checkbox"
              checked={devSettingsStore.data.mockStampEnabled}
              onchange={(e) => devSettingsStore.setMockStampEnabled(e.currentTarget.checked)}
            />
            Enable mock mode
          </label>
        </Horizontal>

        {#if devSettingsStore.data.mockStampEnabled}
          <Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
            <Typography variant="small">Mock result:</Typography>
            <label class="radio-label">
              <input
                type="radio"
                checked={devSettingsStore.data.mockStampResult === 'success'}
                onchange={() => devSettingsStore.setMockStampResult('success')}
              />
              Success
            </label>
            <label class="radio-label">
              <input
                type="radio"
                checked={devSettingsStore.data.mockStampResult === 'error'}
                onchange={() => devSettingsStore.setMockStampResult('error')}
              />
              Error
            </label>
          </Horizontal>
        {/if}
      </Vertical>

      <Divider --margin="var(--padding) 0" />

      <Typography variant="h3">Buy Postage Stamp</Typography>
      <Typography variant="small">
        Buy a postage stamp on the local blockchain for testing uploads.
      </Typography>

      <Vertical --vertical-gap="var(--half-padding)">
        <Input label="Bee Node URL" bind:value={beeUrl} />
        <Horizontal --horizontal-gap="var(--padding)">
          <Input label="Amount" bind:value={stampAmount} style="flex: 1;" />
          <Input label="Depth (17-40)" bind:value={stampDepth} style="width: 120px;" />
        </Horizontal>
        {#if currentPrice !== undefined}
          {@const minAmount = calculateStampAmountForDays(currentPrice, 1)}
          <Typography variant="small" style="color: var(--colors-medium);">
            Chain price: {currentPrice.toLocaleString()} PLUR/chunk/block · 24h min: {minAmount.toLocaleString()}
            PLUR · default fills {DEFAULT_STAMP_DAYS}d validity
          </Typography>
        {:else if chainStateError}
          <Typography variant="small" style="color: var(--colors-error);">
            Could not fetch chainstate from Bee: {chainStateError}
          </Typography>
        {/if}
        <Select label="Signer Key" items={KNOWN_SIGNERS} bind:value={selectedSigner} />
      </Vertical>

      <Button onclick={buyStamp} busy={buying} disabled={buying || !stampAmount}>
        {buying ? 'Buying...' : 'Buy Stamp'}
      </Button>

      {#if stampResult}
        {@const batchId = stampResult.batchID}
        {@const txHash = stampResult.txHash}
        <Vertical
          --vertical-gap="var(--padding)"
          style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
        >
          <Typography font="mono">✅ Stamp purchased!</Typography>

          <Vertical --vertical-gap="var(--half-padding)">
            <Typography variant="small" style="color: var(--colors-medium);">Batch ID</Typography>
            <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
              <Typography font="mono" variant="small" style="word-break: break-all;"
                >{batchId}</Typography
              >
              <CopyButton text={batchId} />
            </Horizontal>
          </Vertical>

          <Horizontal --horizontal-gap="var(--double-padding)">
            <Vertical --vertical-gap="var(--half-padding)">
              <Typography variant="small" style="color: var(--colors-medium);">Amount</Typography>
              <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
                <Typography font="mono" variant="small">{stampAmount}</Typography>
                <CopyButton text={stampAmount} />
              </Horizontal>
            </Vertical>
            <Vertical --vertical-gap="var(--half-padding)">
              <Typography variant="small" style="color: var(--colors-medium);">Depth</Typography>
              <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
                <Typography font="mono" variant="small">{stampDepth}</Typography>
                <CopyButton text={stampDepth} />
              </Horizontal>
            </Vertical>
          </Horizontal>

          <Vertical --vertical-gap="var(--half-padding)">
            <Typography variant="small" style="color: var(--colors-medium);"
              >Signer Key (for Stamper)</Typography
            >
            <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
              <Typography font="mono" variant="small" style="word-break: break-all;"
                >{selectedSigner}</Typography
              >
              <CopyButton text={selectedSigner} />
            </Horizontal>
          </Vertical>

          <Vertical --vertical-gap="var(--half-padding)">
            <Typography variant="small" style="color: var(--colors-medium);">Tx Hash</Typography>
            <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
              <Typography font="mono" variant="small" style="word-break: break-all;"
                >{txHash}</Typography
              >
              <CopyButton text={txHash} />
            </Horizontal>
          </Vertical>

          <Typography
            variant="small"
            style="color: var(--colors-medium); margin-top: var(--half-padding);"
          >
            Note: Wait ~30s for stamp to become usable.
          </Typography>
        </Vertical>
      {/if}

      {#if stampError}
        <Vertical
          style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
        >
          <Typography font="mono" style="color: var(--colors-error);">❌ {stampError}</Typography>
        </Vertical>
      {/if}

      <Divider --margin="var(--padding) 0" />

      <Typography variant="h3">Stored Stamps (local)</Typography>
      <Typography variant="small" style="color: var(--colors-medium);">
        The postage batches saved in this browser. Copy these fields before clearing storage — paste
        them into the "Use existing one" screen to re-adopt the same batch on a fresh account (the
        owner is derived from the signer key). Delete removes the stamp locally only (no sync).
      </Typography>
      {#if storedStampMessage}
        <Typography font="mono" variant="small">{storedStampMessage}</Typography>
      {/if}
      {#if storedStampRows.length === 0}
        <Typography variant="small" style="color: var(--colors-medium);">
          No stamps stored locally.
        </Typography>
      {:else}
        <Vertical --vertical-gap="var(--half-padding)">
          {#each storedStampRows as { accountId, accountName, stamp } (stamp.batchID.toHex())}
            <Vertical
              --vertical-gap="var(--half-padding)"
              style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
            >
              <Vertical --vertical-gap="var(--half-padding)">
                <Typography variant="small" style="color: var(--colors-medium);"
                  >Batch ID</Typography
                >
                <Horizontal
                  --horizontal-gap="var(--half-padding)"
                  --horizontal-align-items="center"
                >
                  <Typography font="mono" variant="small" style="word-break: break-all;"
                    >{stamp.batchID.toHex()}</Typography
                  >
                  <CopyButton text={stamp.batchID.toHex()} />
                </Horizontal>
              </Vertical>

              <Vertical --vertical-gap="var(--half-padding)">
                <Typography variant="small" style="color: var(--colors-medium);"
                  >Signer Key</Typography
                >
                <Horizontal
                  --horizontal-gap="var(--half-padding)"
                  --horizontal-align-items="center"
                >
                  <Typography font="mono" variant="small" style="word-break: break-all;"
                    >{stamp.signerKey.toHex()}</Typography
                  >
                  <CopyButton text={stamp.signerKey.toHex()} />
                </Horizontal>
              </Vertical>

              <Horizontal --horizontal-gap="var(--double-padding)">
                <Vertical --vertical-gap="var(--half-padding)">
                  <Typography variant="small" style="color: var(--colors-medium);"
                    >Amount</Typography
                  >
                  <Horizontal
                    --horizontal-gap="var(--half-padding)"
                    --horizontal-align-items="center"
                  >
                    <Typography font="mono" variant="small">{stamp.amount.toString()}</Typography>
                    <CopyButton text={stamp.amount.toString()} />
                  </Horizontal>
                </Vertical>
                <Vertical --vertical-gap="var(--half-padding)">
                  <Typography variant="small" style="color: var(--colors-medium);">Depth</Typography
                  >
                  <Horizontal
                    --horizontal-gap="var(--half-padding)"
                    --horizontal-align-items="center"
                  >
                    <Typography font="mono" variant="small">{stamp.depth}</Typography>
                    <CopyButton text={String(stamp.depth)} />
                  </Horizontal>
                </Vertical>
                <Vertical --vertical-gap="var(--half-padding)">
                  <Typography variant="small" style="color: var(--colors-medium);"
                    >Block number</Typography
                  >
                  <Horizontal
                    --horizontal-gap="var(--half-padding)"
                    --horizontal-align-items="center"
                  >
                    <Typography font="mono" variant="small">{stamp.blockNumber}</Typography>
                    <CopyButton text={String(stamp.blockNumber)} />
                  </Horizontal>
                </Vertical>
              </Horizontal>

              <Horizontal
                --horizontal-gap="var(--half-padding)"
                --horizontal-justify-content="space-between"
                --horizontal-align-items="center"
              >
                <Typography variant="small" style="color: var(--colors-medium);">
                  Account: {accountName}
                </Typography>
                <Button
                  variant="secondary"
                  danger
                  dimension="compact"
                  onclick={() => deleteStoredStamp(accountId, stamp.batchID)}>Delete</Button
                >
              </Horizontal>
            </Vertical>
          {/each}
        </Vertical>
      {/if}

      <Divider --margin="var(--padding) 0" />

      <Typography variant="h3">Retrievability self-check</Typography>
      <Typography variant="small" style="color: var(--colors-medium);">
        Writes a throwaway single-owner chunk to the Bee node from network settings ({networkSettingsStore.beeNodeUrl})
        and reads it back, to confirm the node actually serves back what you write. Multi-device
        coordination (and reliable sync/download) only works when this succeeds.
      </Typography>
      <Vertical --vertical-gap="var(--half-padding)">
        <Select
          label="Pay with stored stamp"
          items={storedStampOptions}
          bind:value={selfCheckStampId}
        />
        <Button
          onclick={runRetrievabilityCheck}
          busy={selfCheckRunning}
          disabled={selfCheckRunning || !selfCheckStampId}
        >
          {selfCheckRunning ? 'Checking…' : 'Run self-check'}
        </Button>
      </Vertical>
      {#if selfCheckLog.length}
        <Vertical
          --vertical-gap="var(--half-padding)"
          style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
        >
          {#each selfCheckLog as line, i (i)}
            <Typography font="mono" variant="small" style="word-break: break-all;"
              >{line}</Typography
            >
          {/each}
          {#if selfCheckSocAddress}
            <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
              <Typography variant="small" style="color: var(--colors-medium);">
                SOC address (copy to another device):
              </Typography>
              <CopyButton text={selfCheckSocAddress} />
            </Horizontal>
          {/if}
        </Vertical>
      {/if}

      <Typography
        variant="small"
        style="color: var(--colors-medium); margin-top: var(--half-padding);"
      >
        Cross-device check: run the self-check on another device, copy its SOC address, paste it
        here, and read it back. The writer reading its own chunk can succeed on a load-balanced
        gateway even when a different device cannot — this is the read that mirrors coordination.
      </Typography>
      <Vertical --vertical-gap="var(--half-padding)">
        <Input label="Chunk address from another device" bind:value={readAddr} />
        <Button
          variant="secondary"
          onclick={runReadByAddress}
          busy={readChecking}
          disabled={readChecking || !readAddr}
        >
          {readChecking ? 'Reading…' : 'Read by address'}
        </Button>
      </Vertical>
      {#if readLog.length}
        <Vertical
          --vertical-gap="var(--half-padding)"
          style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
        >
          {#each readLog as line, i (i)}
            <Typography font="mono" variant="small" style="word-break: break-all;"
              >{line}</Typography
            >
          {/each}
        </Vertical>
      {/if}

      <Divider --margin="var(--padding) 0" />

      <Typography variant="h3">Partition tuning</Typography>
      <Typography variant="small" style="color: var(--colors-medium);">
        Tune the multi-device intent-round timing for this gateway's propagation delay. Blank =
        library default (window 12000 / poll 2500 / read 2500 ms). Reload the app after saving so
        the proxy picks it up.
      </Typography>
      <Vertical --vertical-gap="var(--half-padding)">
        <Input label="Guard window (ms)" bind:value={tuningWindow} />
        <Input label="Poll interval (ms)" bind:value={tuningPoll} />
        <Input label="Read timeout (ms)" bind:value={tuningTimeout} />
        <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
          <Button onclick={saveTuning}>Save tuning</Button>
          <Button variant="secondary" onclick={resetTuning}>Reset to defaults</Button>
        </Horizontal>
        {#if tuningSaved}
          <Typography variant="small" style="color: var(--colors-medium);">{tuningSaved}</Typography
          >
        {/if}
      </Vertical>

      <Divider --margin="var(--padding) 0" />

      <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
        <Typography variant="h3">Existing Stamps (Bee Node)</Typography>
        <Button variant="secondary" onclick={loadBeeStamps} busy={beeStampsLoading}>
          {beeStampsLoading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </Horizontal>
      {#if beeStampsError}
        <Typography variant="small" style="color: var(--colors-error);">
          ❌ {beeStampsError}
        </Typography>
      {/if}
      {#if beeStamps.length === 0}
        <Typography variant="small" style="color: var(--colors-medium);">
          No stamps found on the Bee node.
        </Typography>
      {:else}
        <Vertical --vertical-gap="var(--half-padding)">
          {#each beeStamps as stamp (stamp.batchID)}
            <Vertical
              style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low);"
            >
              <Horizontal
                --horizontal-justify-content="space-between"
                --horizontal-align-items="center"
              >
                <Typography font="mono">{stamp.batchID}</Typography>
                <CopyButton text={stamp.batchID} />
              </Horizontal>
              <Horizontal --horizontal-gap="var(--half-padding)">
                <Typography variant="small" style="color: var(--colors-medium);">
                  Depth: {stamp.depth}
                </Typography>
                <Typography variant="small" style="color: var(--colors-medium);">
                  Utilization: {stamp.utilization}
                </Typography>
                <Typography variant="small" style="color: var(--colors-medium);">
                  Expires: {formatStampExpiry(stamp.batchTTL)}
                </Typography>
                {@const assignment = stampAssignments.get(stamp.batchID)}
                <Typography variant="small" style="color: var(--colors-medium);">
                  Account: {assignment?.account ?? '—'}
                </Typography>
              </Horizontal>
            </Vertical>
          {/each}
        </Vertical>
      {/if}

      <Divider --margin="var(--padding) 0" />

      <Typography variant="h3">Assign Existing Stamp</Typography>
      <Vertical --vertical-gap="var(--half-padding)">
        <Select label="Stamp" items={stampOptions} bind:value={selectedStampId} />
        <Select label="Account" items={accountOptions} bind:value={selectedAccountId} />

        <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={useCustomSigner} />
            Use custom signer key
          </label>
        </Horizontal>

        {#if useCustomSigner}
          <Input
            label="Custom Signer Key"
            bind:value={customSignerKey}
            disabled={!useCustomSigner}
            error={customSignerError}
          />
        {/if}
      </Vertical>

      <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
        <Button onclick={assignAccountStamp} disabled={!selectedStampId || !selectedAccountId}>
          Set Account Stamp
        </Button>
        <Button
          variant="secondary"
          danger
          onclick={removeAccountStamp}
          disabled={!accountHasDefaultStamp}
        >
          Remove Account Stamp
        </Button>
      </Horizontal>

      {#if assignMessage}
        <Typography variant="small" style="color: var(--colors-success, #22c55e);"
          >{assignMessage}</Typography
        >
      {/if}
      {#if assignError}
        <Typography variant="small" style="color: var(--colors-error);">{assignError}</Typography>
      {/if}

      <Divider --margin="var(--padding) 0" />

      <Typography variant="h3">Signer Key / Owner Address</Typography>
      <Typography variant="small" style="color: var(--colors-medium);">
        Buy a stamp online under the owner address, then paste the private key as the signer key in
        the "Use existing one" screen. Reflects the account selected above.
      </Typography>

      {#if !selectedAccountId}
        <Typography variant="small" style="color: var(--colors-medium);">
          Select an account above to view its signer key.
        </Typography>
      {:else}
        <Vertical --vertical-gap="var(--half-padding)">
          {#if accountSigner}
            {@render signerCard('Account-level signer', accountSigner)}
          {/if}
        </Vertical>
      {/if}
    </Vertical>
  {/if}

  <!-- Sync Tab -->
  {#if activeTab === 'sync'}
    <Vertical --vertical-gap="var(--padding)">
      <Typography variant="h3">Manual Sync Testing</Typography>
      <Typography variant="small">
        Trigger a manual sync for ALL accounts to test postage stamp utilization tracking.
      </Typography>
      <Horizontal --horizontal-gap="var(--padding)">
        <Button onclick={triggerManualSync}>Sync All Accounts</Button>
      </Horizontal>

      {#if syncMessage}
        <Vertical
          --vertical-gap="var(--padding)"
          style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low); white-space: pre-wrap;"
        >
          <Typography font="mono">{syncMessage}</Typography>
        </Vertical>
      {/if}

      <Vertical --vertical-gap="var(--half-padding)">
        <Typography variant="small" style="color: var(--colors-medium);"
          >Requirements for sync:</Typography
        >
        <Typography variant="small" style="color: var(--colors-medium);" font="mono">
          • At least one account with a default postage stamp
        </Typography>
        <Typography variant="small" style="color: var(--colors-medium);" font="mono">
          • Open browser console to see detailed logs
        </Typography>
      </Vertical>
    </Vertical>
  {/if}

  <!-- Devices Tab -->
  {#if activeTab === 'devices'}
    <Vertical --vertical-gap="var(--padding)">
      <Typography variant="h3">Account Devices</Typography>
      <Typography variant="small">
        Inspect the devices registered to an account and which partitions they currently hold.
      </Typography>
      <Select label="Account" items={accountOptions} bind:value={selectedAccountId} />
      {#if selectedAccount}
        {#key selectedAccountId}
          <DeviceList account={selectedAccount} />
        {/key}
      {:else}
        <Typography variant="small" style="color: var(--colors-medium);">
          No accounts found.
        </Typography>
      {/if}
    </Vertical>
  {/if}
</Vertical>

<style>
  .checkbox-label,
  .radio-label {
    display: flex;
    align-items: center;
    gap: var(--half-padding);
    cursor: pointer;
  }
</style>
