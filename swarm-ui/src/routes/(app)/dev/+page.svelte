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
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
  import { syncStore } from '$lib/stores/sync.svelte'
  import { devSettingsStore, type MockStampResult } from '$lib/stores/dev-settings.svelte'
  import Tabs from './tabs.svelte'
  import CopyButton from './copy-button.svelte'
  import StatusDot from './status-dot.svelte'
  import Divider from '$lib/components/ui/divider.svelte'
  import routes from '$lib/routes'
  import { BatchId, EthAddress, PrivateKey, Utils } from '@ethersphere/bee-js'
  import { calculateStampAmountForDays, fetchChainState } from '@snaha/swarm-id'
  import { SvelteMap } from 'svelte/reactivity'

  // How many days of validity to fund by default when auto-filling the
  // stamp amount from current chain price. Bee enforces a 24h minimum on
  // POST /stamps; 7 days gives comfortable headroom for dev testing without
  // re-buying constantly.
  const DEFAULT_STAMP_DAYS = 7

  // Tab state
  type Tab = 'overview' | 'stamps' | 'sync'
  let activeTab = $state<Tab>('overview')

  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'stamps', label: 'Stamps' },
    { value: 'sync', label: 'Sync' },
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
  let selectedIdentityId = $state<string | undefined>(undefined)
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

  // Mock stamp widget settings
  let mockStampEnabled = $state(devSettingsStore.data.mockStampEnabled)
  let mockStampResult = $state<MockStampResult>(devSettingsStore.data.mockStampResult)

  $effect(() => {
    devSettingsStore.setMockStampEnabled(mockStampEnabled)
  })

  $effect(() => {
    devSettingsStore.setMockStampResult(mockStampResult)
  })

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
  const accountOptions = $derived(
    accountsStore.accounts.map((account) => ({
      value: account.id.toHex(),
      label: `${account.name} (${account.id.toHex().slice(0, 10)}…)`,
    })),
  )
  const selectedAccount = $derived(
    selectedAccountId ? accountsStore.getAccount(new EthAddress(selectedAccountId)) : undefined,
  )
  const identityOptions = $derived(
    selectedAccount
      ? identitiesStore.getIdentitiesByAccount(selectedAccount.id).map((identity) => ({
          value: identity.id,
          label: `${identity.name} (${identity.id.slice(0, 8)}…)`,
        }))
      : [],
  )
  const accountHasDefaultStamp = $derived(!!selectedAccount?.defaultPostageStampBatchID)
  const selectedIdentity = $derived(
    selectedIdentityId ? identitiesStore.getIdentity(selectedIdentityId) : undefined,
  )
  const identityHasStamp = $derived(!!selectedIdentity?.defaultPostageStampBatchID)
  const stampAssignments = $derived(
    (() => {
      const map = new SvelteMap<string, { account?: string; identity?: string }>()
      for (const account of accountsStore.accounts) {
        const batch = account.defaultPostageStampBatchID?.toHex()
        if (batch) {
          map.set(batch, { ...(map.get(batch) ?? {}), account: account.name })
        }
      }
      for (const identity of identitiesStore.identities) {
        const batch = identity.defaultPostageStampBatchID?.toHex()
        if (batch) {
          const existing = map.get(batch) ?? {}
          const accountName = existing.account ?? accountsStore.getAccount(identity.accountId)?.name
          map.set(batch, {
            ...existing,
            account: accountName,
            identity: identity.name,
          })
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

  $effect(() => {
    if (identityOptions.length && !selectedIdentityId) {
      selectedIdentityId = identityOptions[0].value
    } else if (
      selectedIdentityId &&
      !identityOptions.some((option) => option.value === selectedIdentityId)
    ) {
      selectedIdentityId = identityOptions[0]?.value
    }
  })

  async function triggerManualSync() {
    // Get all accounts with default stamps (account-level or via identities)
    const accountsToSync = accountsStore.accounts.filter(
      (account) =>
        account.defaultPostageStampBatchID ||
        identitiesStore
          .getIdentitiesByAccount(account.id)
          .some((id) => id.defaultPostageStampBatchID),
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
        const defaultStamp =
          account.defaultPostageStampBatchID ??
          identitiesStore.getIdentitiesByAccount(account.id)[0]?.defaultPostageStampBatchID

        const stamp = defaultStamp ? postageStampsStore.getStamp(defaultStamp) : undefined
        const utilization = stamp ? stamp.utilization.toFixed(2) : 'unknown'

        const identityCount = identitiesStore.getIdentitiesByAccount(account.id).length

        if (result.status === 'success-unverified') {
          results.push(
            `⚠️ ${account.name} (${identityCount} identities): synced, but root chunk not retrievable — ${result.warning}`,
          )
          errorCount++
          continue
        }

        results.push(
          `✅ ${account.name} (${identityCount} identities): ${utilization}% utilization`,
        )
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
      const response = await fetch(`${beeUrl}/stamps/${stampAmount}/${stampDepth}`, {
        method: 'POST',
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

  function clearAllData() {
    accountsStore.clear()
    identitiesStore.clear()
    connectedAppsStore.clear()
    postageStampsStore.clear()
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
        postageStampsStore.addStamp(
          {
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
          },
          selectedAccountId,
        )
      } else if (useCustomSigner) {
        const beeStamp = postageStampsStore.getStamp(batchId)
        if (!beeStamp) {
          assignError = 'Stamp not found in local storage.'
          return
        }
        if (beeStamp.signerKey !== signerKeyToUse) {
          postageStampsStore.removeStamp(batchId, selectedAccountId)
          postageStampsStore.addStamp(
            {
              ...beeStamp,
              signerKey: signerKeyToUse,
            },
            selectedAccountId,
          )
        }
      }

      accountsStore.setDefaultStamp(accountId, batchId)
      assignMessage = `✅ Set account stamp for ${accountId.toHex().slice(0, 8)}…`
    } catch (error) {
      assignError = error instanceof Error ? error.message : String(error)
    }
  }

  function assignIdentityStamp() {
    assignError = ''
    assignMessage = ''
    if (!accountHasDefaultStamp) {
      assignError = 'Account must have a default stamp before assigning identity stamp.'
      return
    }
    if (!selectedStampId || !selectedIdentityId || !selectedAccountId) {
      assignError = 'Select a stamp, account, and identity first.'
      return
    }

    // Validate custom signer if enabled
    if (useCustomSigner && customSignerError) {
      assignError = customSignerError
      return
    }

    try {
      const batchId = new BatchId(selectedStampId)

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
        postageStampsStore.addStamp(
          {
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
          },
          selectedAccountId,
        )
      }

      identitiesStore.setDefaultStamp(selectedIdentityId, batchId)
      assignMessage = `✅ Set identity stamp for ${selectedIdentityId.slice(0, 8)}…`
    } catch (error) {
      assignError = error instanceof Error ? error.message : String(error)
    }
  }

  function removeIdentityStamp() {
    assignError = ''
    assignMessage = ''
    if (!selectedIdentityId) {
      assignError = 'Select an identity first.'
      return
    }
    identitiesStore.setDefaultStamp(selectedIdentityId, undefined)
    assignMessage = `✅ Removed identity stamp from ${selectedIdentityId.slice(0, 8)}…`
  }

  function removeAccountStamp() {
    assignError = ''
    assignMessage = ''
    if (!selectedAccountId) {
      assignError = 'Select an account first.'
      return
    }
    if (identityHasStamp) {
      assignError = 'Remove identity stamp first before removing account stamp.'
      return
    }
    accountsStore.setDefaultStamp(new EthAddress(selectedAccountId), undefined)
    assignMessage = `✅ Removed account stamp from ${selectedAccountId.slice(0, 8)}…`
  }
</script>

<Vertical
  --vertical-gap="var(--double-padding)"
  style="max-width: 800px; padding: var(--double-padding);"
>
  <Typography variant="h2">Developer Tools</Typography>

  <Tabs {tabs} bind:active={activeTab} />

  <!-- Overview Tab -->
  {#if activeTab === 'overview'}
    {@const accountCount = accountsStore.accounts.length}
    {@const identityCount = identitiesStore.identities.length}
    {@const connectionCount = connectedAppsStore.apps.length}
    {@const stampCount = postageStampsStore.stamps.length}
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
          {accountCount} accounts, {identityCount} identities, {connectionCount} connections, {stampCount}
          stamps
        </Typography>
        <Button variant="secondary" danger onclick={clearAllData}>Clear All Data</Button>
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
            <input type="checkbox" bind:checked={mockStampEnabled} />
            Enable mock mode
          </label>
        </Horizontal>

        {#if mockStampEnabled}
          <Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
            <Typography variant="small">Mock result:</Typography>
            <label class="radio-label">
              <input type="radio" value="success" bind:group={mockStampResult} />
              Success
            </label>
            <label class="radio-label">
              <input type="radio" value="error" bind:group={mockStampResult} />
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
                {@const assignment = stampAssignments.get(stamp.batchID)}
                <Typography variant="small" style="color: var(--colors-medium);">
                  Account: {assignment?.account ?? '—'}
                </Typography>
                <Typography variant="small" style="color: var(--colors-medium);">
                  Identity: {assignment?.identity ?? '—'}
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
        <Select
          label="Identity"
          items={identityOptions}
          bind:value={selectedIdentityId}
          disabled={!accountHasDefaultStamp}
        />

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
          onclick={assignIdentityStamp}
          disabled={!accountHasDefaultStamp || !selectedStampId || !selectedIdentityId}
        >
          Set Identity Stamp
        </Button>
      </Horizontal>

      <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
        <Button
          variant="secondary"
          danger
          onclick={removeAccountStamp}
          disabled={!accountHasDefaultStamp || identityHasStamp}
        >
          Remove Account Stamp
        </Button>
        <Button
          variant="secondary"
          danger
          onclick={removeIdentityStamp}
          disabled={!identityHasStamp}
        >
          Remove Identity Stamp
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
