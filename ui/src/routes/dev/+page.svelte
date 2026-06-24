<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'

  import { Utils } from '@ethersphere/bee-js'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { calculateStampAmountForDays, fetchChainState } from '@snaha/swarm-id'

  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { Tabs } from '$lib/components/ui/tabs'
  import { removeAllSharedAccountRecords } from '$lib/connect-handshake'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Drive } from '$lib/types'
  import { truncateAddress } from '$lib/utils'

  import { type BeeStamp, type EndpointProbe, beeDev } from './bee'
  import CopyButton from './copy-button.svelte'
  import StatusDot from './status-dot.svelte'

  // Local bee-compose cluster endpoints (see .claude/rules/bee-cluster.md).
  const QUEEN_API = 'http://localhost:1633'
  const WORKER_API = 'http://localhost:16331'
  const BLOCKCHAIN_RPC = 'http://localhost:9545'
  // Demo dApp origin under `pnpm dev:new` (see root package.json dev:demo:new).
  const DEMO_ORIGIN = 'http://localhost:3500'

  const ENDPOINTS: { label: string; url: string; probe: EndpointProbe }[] = [
    { label: 'Queen API', url: QUEEN_API, probe: 'head' },
    { label: 'Worker API', url: WORKER_API, probe: 'head' },
    { label: 'Blockchain RPC', url: BLOCKCHAIN_RPC, probe: 'json-rpc' },
  ]

  // Default validity to fund when auto-filling the amount from chain price. Bee
  // enforces a 24h minimum; 7 days gives headroom for dev testing.
  const DEFAULT_STAMP_DAYS = 7
  const BATCH_ID_PREVIEW = 10
  const SIGNER_KEY_LENGTH = 64

  // Known dev signers (pre-funded with ETH + BZZ in the local Bee cluster).
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

  const TABS = [
    { value: 'overview', label: 'Overview' },
    { value: 'stamps', label: 'Stamps' },
  ]
  let activeTab = $state('overview')

  // ── Buy-stamp state ────────────────────────────────────────────────────────
  let beeUrl = $state(QUEEN_API)
  // Amount starts empty — autofilled from chain price on first load. Hardcoding
  // a default is fragile across chain configs (each has its own price floor).
  let stampAmount = $state('')
  let stampDepth = $state('20')
  let buying = $state(false)
  let stampResult = $state<{ batchID: string; txHash: string } | undefined>(undefined)
  let stampError = $state('')
  let currentPrice = $state<bigint | undefined>(undefined)
  let chainStateError = $state('')
  let selectedSigner = $state(KNOWN_SIGNERS[0].value)

  // ── Bee-node stamp listing ──────────────────────────────────────────────────
  let beeStamps = $state<BeeStamp[]>([])
  let beeStampsLoading = $state(false)
  let beeStampsError = $state('')
  let lastBeeUrl = $state('')

  // ── Assign-to-account state ─────────────────────────────────────────────────
  // Empty string = no selection (matches the Select component's string value).
  let selectedStampId = $state('')
  let selectedAccountId = $state('')
  let useCustomSigner = $state(false)
  let customSignerKey = $state('')
  let assignMessage = $state('')
  let assignError = $state('')

  const customSignerError = $derived.by(() => {
    if (!useCustomSigner) {
      return undefined
    }
    if (customSignerKey.length === 0) {
      return 'Custom signer key is required'
    }
    if (!/^[0-9a-fA-F]+$/.test(customSignerKey)) {
      return 'Signer key must be a valid hex string'
    }
    if (customSignerKey.length !== SIGNER_KEY_LENGTH) {
      return `Signer key must be exactly ${SIGNER_KEY_LENGTH} hex characters`
    }
    return undefined
  })

  // ── Overview counts ──────────────────────────────────────────────────────────
  const accountCount = $derived(accountsStore.accounts.length)
  const driveCount = $derived(
    accountsStore.accounts.reduce((total, account) => total + account.drives.length, 0),
  )
  const connectionCount = $derived(
    accountsStore.accounts.reduce((total, account) => total + account.connectedApps.length, 0),
  )

  // ── Derived options ──────────────────────────────────────────────────────────
  const stampOptions = $derived(
    beeStamps.map((stamp) => ({
      value: stamp.batchID,
      label: `${stamp.batchID.slice(0, BATCH_ID_PREVIEW)}… (depth ${stamp.depth})`,
    })),
  )
  const accountOptions = $derived(
    accountsStore.accounts.map((account) => ({
      value: account.id,
      label: `${account.name} (${truncateAddress(account.id)})`,
    })),
  )
  const selectedAccount = $derived(
    selectedAccountId ? accountsStore.get(selectedAccountId) : undefined,
  )

  // batchId → which account holds it as a drive (and whether it is that account's default).
  const driveAssignments = $derived.by(() => {
    const map = new SvelteMap<string, string>()
    for (const account of accountsStore.accounts) {
      for (const drive of account.drives) {
        const isDefault = account.defaultDriveBatchId === drive.batchId
        map.set(drive.batchId, isDefault ? `${account.name} (default)` : account.name)
      }
    }
    return map
  })

  // Keep the selected stamp/account valid as the underlying lists change.
  $effect(() => {
    if (stampOptions.length && !stampOptions.some((option) => option.value === selectedStampId)) {
      selectedStampId = stampOptions[0].value
    } else if (stampOptions.length === 0) {
      selectedStampId = ''
    }
  })
  $effect(() => {
    if (
      accountOptions.length &&
      !accountOptions.some((option) => option.value === selectedAccountId)
    ) {
      selectedAccountId = accountOptions[0].value
    } else if (accountOptions.length === 0) {
      selectedAccountId = ''
    }
  })

  // Load node stamps + chain price the first time the Stamps tab opens (and
  // whenever the bee URL changes).
  $effect(() => {
    if (activeTab === 'stamps' && beeUrl && beeUrl !== lastBeeUrl && !beeStampsLoading) {
      loadBeeStamps()
      loadChainState()
    }
  })

  async function loadBeeStamps() {
    beeStampsLoading = true
    beeStampsError = ''
    try {
      beeStamps = await beeDev.fetchStamps(beeUrl)
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
      // Only autofill while the field is untouched; after that the user owns it.
      if (stampAmount === '') {
        stampAmount = calculateStampAmountForDays(state.currentPrice, DEFAULT_STAMP_DAYS).toString()
      }
    } catch (error) {
      chainStateError = error instanceof Error ? error.message : String(error)
      currentPrice = undefined
    }
  }

  async function buyStamp() {
    buying = true
    stampError = ''
    stampResult = undefined
    try {
      stampResult = await beeDev.buyStamp(beeUrl, stampAmount, stampDepth)
      // Reflect the freshly bought batch in the list without a manual refresh.
      await loadBeeStamps()
    } catch (error) {
      stampError = error instanceof Error ? error.message : String(error)
    } finally {
      buying = false
    }
  }

  function assignDrive() {
    assignError = ''
    assignMessage = ''
    const account = selectedAccount
    if (!selectedStampId || !account) {
      assignError = 'Select a stamp and an account first.'
      return
    }
    if (useCustomSigner && customSignerError) {
      assignError = customSignerError
      return
    }

    const beeStamp = beeStamps.find((stamp) => stamp.batchID === selectedStampId)
    if (!beeStamp) {
      assignError = 'Stamp data not found. Reload stamps first.'
      return
    }

    const signerKey = useCustomSigner ? customSignerKey.toLowerCase() : selectedSigner
    const drive: Drive = {
      batchId: beeStamp.batchID,
      signerKey,
      depth: beeStamp.depth,
      amount: beeStamp.amount,
      bucketDepth: beeStamp.bucketDepth,
      blockNumber: beeStamp.blockNumber,
      immutableFlag: beeStamp.immutableFlag,
      utilization: Utils.getStampUsage(beeStamp.utilization, beeStamp.depth, beeStamp.bucketDepth),
      usable: beeStamp.usable,
      exists: beeStamp.exists,
      batchTTL: beeStamp.batchTTL,
      createdAt: Date.now(),
    }
    account.addDrive(drive)
    account.setDefaultDrive(beeStamp.batchID)
    assignMessage = `Assigned drive to ${truncateAddress(account.id)} and set as default.`
  }

  function removeDrive() {
    assignError = ''
    assignMessage = ''
    const account = selectedAccount
    if (!selectedStampId || !account) {
      assignError = 'Select a stamp and an account first.'
      return
    }
    account.removeDrive(selectedStampId)
    assignMessage = `Removed drive from ${truncateAddress(account.id)}.`
  }

  function clearAllData() {
    if (!confirm('Delete all accounts, drives and connections on this device?')) {
      return
    }
    accountsStore.clear()
    removeAllSharedAccountRecords()
    sessionStore.clearCurrentAccount()
  }

  const connectUrl = $derived(
    `${resolve(routes.CONNECT)}#origin=${encodeURIComponent(DEMO_ORIGIN)}&appName=Demo`,
  )
</script>

<!--
  All <a> links on this dev page are intentionally non-router targets: external
  Bee/RPC endpoints (open in a new tab) and the connect popup's hash-encoded
  request. Internal navigation uses <Button href={resolve(...)}> instead.
-->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="flex min-h-svh flex-col">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8 pb-16">
    <div class="flex w-full max-w-2xl flex-col gap-6">
      <h1 class="text-lg font-bold">Developer Tools</h1>

      <Tabs tabs={TABS} bind:value={activeTab} />

      {#if activeTab === 'overview'}
        <section class="flex flex-col gap-3">
          <h2 class="text-sm font-bold">Local Bee endpoints</h2>
          {#each ENDPOINTS as endpoint (endpoint.url)}
            <div class="flex items-center gap-2 text-sm">
              <StatusDot endpoint={endpoint.url} probe={endpoint.probe} />
              <span class="text-muted-foreground w-28 shrink-0">{endpoint.label}</span>
              <a
                href={endpoint.url}
                target="_blank"
                rel="noopener"
                class="text-primary font-mono underline-offset-4 hover:underline"
              >
                {endpoint.url}
              </a>
              <CopyButton text={endpoint.url} />
            </div>
          {/each}
        </section>

        <section class="flex flex-col gap-3">
          <h2 class="text-sm font-bold">Test connect flow</h2>
          <p class="text-muted-foreground text-sm">
            Open the connect popup for the local demo app.
          </p>
          <div class="flex items-center gap-2 text-sm">
            <StatusDot endpoint={DEMO_ORIGIN} />
            <a href={connectUrl} class="text-primary font-mono underline-offset-4 hover:underline">
              {DEMO_ORIGIN} (demo)
            </a>
            <CopyButton text={connectUrl} />
          </div>
        </section>

        <section class="flex flex-col items-start gap-3">
          <h2 class="text-sm font-bold">Local data</h2>
          <p class="text-sm">
            {accountCount} accounts · {driveCount} drives · {connectionCount} connections
          </p>
          <Button variant="destructive" onclick={clearAllData}>Clear all data</Button>
        </section>
      {:else if activeTab === 'stamps'}
        <section class="flex flex-col gap-3">
          <h2 class="text-sm font-bold">Buy postage stamp</h2>
          <p class="text-muted-foreground text-sm">
            Buy a stamp on the local chain for testing uploads.
          </p>

          <label class="flex flex-col gap-1.5 text-sm">
            <span class="text-muted-foreground">Bee node URL</span>
            <Input bind:value={beeUrl} />
          </label>

          <div class="flex gap-3">
            <label class="flex flex-1 flex-col gap-1.5 text-sm">
              <span class="text-muted-foreground">Amount</span>
              <Input bind:value={stampAmount} />
            </label>
            <label class="flex w-28 flex-col gap-1.5 text-sm">
              <span class="text-muted-foreground">Depth (17–40)</span>
              <Input bind:value={stampDepth} />
            </label>
          </div>

          {#if currentPrice !== undefined}
            {@const minAmount = calculateStampAmountForDays(currentPrice, 1)}
            <p class="text-muted-foreground text-xs">
              Chain price: {currentPrice.toLocaleString()} PLUR/chunk/block · 24h min: {minAmount.toLocaleString()}
              PLUR · default fills {DEFAULT_STAMP_DAYS}d
            </p>
          {:else if chainStateError}
            <p class="text-destructive text-xs">Could not fetch chainstate: {chainStateError}</p>
          {/if}

          <label class="flex flex-col gap-1.5 text-sm">
            <span class="text-muted-foreground">Signer key</span>
            <Select options={KNOWN_SIGNERS} bind:value={selectedSigner} />
          </label>

          <Button class="self-start" disabled={buying || !stampAmount} onclick={buyStamp}>
            {#if buying}
              <LoaderCircle class="animate-spin" />
            {/if}
            {buying ? 'Buying…' : 'Buy stamp'}
          </Button>

          {#if stampResult}
            <div class="bg-card flex flex-col gap-3 rounded-lg border p-4">
              <p class="text-success text-sm font-medium">Stamp purchased</p>
              {#each [{ label: 'Batch ID', value: stampResult.batchID }, { label: 'Amount', value: stampAmount }, { label: 'Depth', value: stampDepth }, { label: 'Signer key', value: selectedSigner }, { label: 'Tx hash', value: stampResult.txHash }] as field (field.label)}
                <div class="flex flex-col gap-1">
                  <span class="text-muted-foreground text-xs">{field.label}</span>
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono text-xs break-all">{field.value}</span>
                    <CopyButton text={field.value} />
                  </div>
                </div>
              {/each}
              <p class="text-muted-foreground text-xs">Wait ~30s for the stamp to become usable.</p>
            </div>
          {/if}

          {#if stampError}
            <p class="text-destructive text-sm">{stampError}</p>
          {/if}
        </section>

        <div class="bg-border h-px w-full"></div>

        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-bold">Stamps on the Bee node</h2>
            <Button variant="outline" disabled={beeStampsLoading} onclick={loadBeeStamps}>
              {#if beeStampsLoading}
                <LoaderCircle class="animate-spin" />
              {/if}
              Refresh
            </Button>
          </div>

          {#if beeStampsError}
            <p class="text-destructive text-sm">{beeStampsError}</p>
          {/if}

          {#if beeStamps.length === 0}
            <p class="text-muted-foreground text-sm">No stamps found on the Bee node.</p>
          {:else}
            <div class="flex flex-col gap-2">
              {#each beeStamps as stamp (stamp.batchID)}
                <div class="bg-card flex flex-col gap-1 rounded-lg border p-3">
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono text-xs break-all">{stamp.batchID}</span>
                    <CopyButton text={stamp.batchID} />
                  </div>
                  <div class="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
                    <span>Depth: {stamp.depth}</span>
                    <span>Usable: {stamp.usable ? 'yes' : 'no'}</span>
                    <span>Assigned: {driveAssignments.get(stamp.batchID) ?? '—'}</span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <div class="bg-border h-px w-full"></div>

        <section class="flex flex-col gap-3">
          <h2 class="text-sm font-bold">Assign drive to account</h2>

          {#if accountOptions.length === 0}
            <p class="text-muted-foreground text-sm">Create an account first to assign a drive.</p>
          {:else if stampOptions.length === 0}
            <p class="text-muted-foreground text-sm">No stamps on the node to assign yet.</p>
          {:else}
            <label class="flex flex-col gap-1.5 text-sm">
              <span class="text-muted-foreground">Stamp</span>
              <Select options={stampOptions} bind:value={selectedStampId} />
            </label>
            <label class="flex flex-col gap-1.5 text-sm">
              <span class="text-muted-foreground">Account</span>
              <Select options={accountOptions} bind:value={selectedAccountId} />
            </label>

            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" bind:checked={useCustomSigner} />
              Use custom signer key
            </label>
            {#if useCustomSigner}
              <label class="flex flex-col gap-1.5 text-sm">
                <span class="text-muted-foreground">Custom signer key</span>
                <Input bind:value={customSignerKey} aria-invalid={!!customSignerError} />
                {#if customSignerError}
                  <span class="text-destructive text-xs">{customSignerError}</span>
                {/if}
              </label>
            {/if}

            <div class="flex gap-2">
              <Button disabled={useCustomSigner && !!customSignerError} onclick={assignDrive}>
                Assign and set default
              </Button>
              <Button
                variant="destructive"
                disabled={!selectedAccount?.drives.some((d) => d.batchId === selectedStampId)}
                onclick={removeDrive}
              >
                Remove from account
              </Button>
            </div>

            {#if assignMessage}
              <p class="text-success text-sm">{assignMessage}</p>
            {/if}
            {#if assignError}
              <p class="text-destructive text-sm">{assignError}</p>
            {/if}
          {/if}
        </section>
      {/if}
    </div>
  </main>
</div>
