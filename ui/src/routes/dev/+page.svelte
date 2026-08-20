<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { untrack } from 'svelte'

  import { BatchId, Bee, EthAddress, Identifier, PrivateKey } from '@ethersphere/bee-js'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Info from '@lucide/svelte/icons/info'
  import Settings from '@lucide/svelte/icons/settings'
  import {
    DEFAULT_BEE_NODE_URL,
    DEFAULT_GNOSIS_RPC_URL,
    derivePostageSignerKey,
    downloadEncryptedSOC,
    rejectAfter,
    uint8ArrayToHex,
    uploadSOC,
  } from '@snaha/swarm-id'
  import { gnosisMainnetSettings } from '@swarm-id/multichain'
  import { formatUnits, parseUnits } from 'viem'

  import { resolve } from '$app/paths'

  import CopyButton from '$lib/components/copy-button.svelte'
  import NetworkSettingsDialog from '$lib/components/network-settings-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import {
    DropdownMenu,
    DropdownMenuItem,
    DropdownMenuSeparator,
  } from '$lib/components/ui/dropdown-menu'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { Tabs } from '$lib/components/ui/tabs'
  import {
    ANVIL_ACCOUNT,
    type FundsRow,
    createExpiringTestDrive,
    createOwnedBatchOnChain,
    createTestDrive,
    devChainFunds,
    sendFromFaucet,
  } from '$lib/dev/chain-funding'
  import { postageStampsStore } from '$lib/dev/postage-stamps.svelte'
  import { syncStore } from '$lib/dev/sync.svelte'
  import { chainIdentity, evictChainCaches, probeChainId } from '$lib/payment/chain'
  import { fetchExistingBatchFromChain } from '$lib/payment/contract'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
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

  /**
   * The local endpoints "Use local" points the app at. Two chains can be
   * serving Gnosis locally — bee-compose's cluster and the standalone snapshot
   * — so it asks which is actually answering rather than making the user
   * remember. The cluster comes first: it also serves the Bee node, so if it
   * is up that is the environment you want. This lives here rather than in
   * Network settings, which ships to production.
   */
  const LOCAL_BEE_NODE_URL = 'http://localhost:1633/'
  const LOCAL_GNOSIS_RPC_URLS = ['http://localhost:9545', 'http://localhost:8545']
  /** Worker 1 of the same cluster; only meaningful while the queen is in use. */
  const LOCAL_CLUSTER_WORKER_URL = 'http://localhost:16331'

  /**
   * Which environment the saved endpoints amount to — the one word the menu
   * needs. Anything else, a gateway or a colleague's node, is `Custom`: the
   * pair is what makes an environment, so one preset URL beside a hand-typed
   * one is not that preset.
   */
  /**
   * Endpoints compared as URLs rather than as strings: the settings dialog
   * saves whatever was typed, and `http://localhost:1633` is the same node as
   * the `http://localhost:1633/` written here. Anything unparseable can only be
   * `Custom`, so it compares as itself.
   */
  function sameEndpoint(a: string, b: string): boolean {
    return normalizeEndpoint(a) === normalizeEndpoint(b)
  }

  function normalizeEndpoint(url: string): string {
    try {
      return new URL(url.trim()).href
    } catch {
      return url.trim()
    }
  }

  const endpointMode = $derived.by(() => {
    const { beeNodeUrl, gnosisRpcUrl } = networkSettingsStore
    if (
      sameEndpoint(beeNodeUrl, LOCAL_BEE_NODE_URL) &&
      LOCAL_GNOSIS_RPC_URLS.some((url) => sameEndpoint(url, gnosisRpcUrl))
    ) {
      return 'Local'
    }
    if (
      sameEndpoint(beeNodeUrl, DEFAULT_BEE_NODE_URL) &&
      sameEndpoint(gnosisRpcUrl, DEFAULT_GNOSIS_RPC_URL)
    ) {
      return 'Production'
    }
    return 'Custom'
  })

  let networkDialogOpen = $state(false)

  /**
   * Bumped to re-ask which chain is there: only the endpoint changing re-runs
   * the await, so a page opened before the local chain was up would otherwise
   * read "No chain reachable" until it is reloaded.
   */
  let chainProbeAttempt = $state(0)

  /**
   * Really re-ask. Bumping the counter alone only re-runs the await, which for
   * an answer already cached hands back the same one — so a localhost port
   * restarted as a different chain would keep reporting the old one. Dropping
   * the cached answer first is what makes Retry mean "look again", which is
   * why every branch of the banner offers it and not just the failed one.
   */
  function retryChainProbe() {
    evictChainCaches(networkSettingsStore.gnosisRpcUrl)
    chainProbeAttempt++
  }

  /**
   * Which endpoint switch is the live one. "Use local" spends up to ~5s
   * probing, and nobody is obliged to wait for it: picking production
   * meanwhile — the natural move when the locals are plainly down — used to be
   * silently undone when those probes finally landed. Each switch supersedes
   * the one before it, which is all this needs; the attempt guard in
   * `$lib/attempt` is for cancellable ceremonies, not a two-line token.
   */
  let endpointSwitchAttempt = 0

  // Both presets apply straight away; anything else goes through the product's
  // own Network settings dialog rather than a second copy of its fields.
  async function useLocalEndpoints() {
    const attempt = ++endpointSwitchAttempt
    const reachable = await Promise.all(
      LOCAL_GNOSIS_RPC_URLS.map((url) =>
        probeChainId(url).then(
          () => url,
          () => undefined,
        ),
      ),
    )
    if (attempt !== endpointSwitchAttempt) return
    const gnosisRpcUrl = reachable.find((url) => url !== undefined) ?? LOCAL_GNOSIS_RPC_URLS[0]
    networkSettingsStore.updateSettings({ beeNodeUrl: LOCAL_BEE_NODE_URL, gnosisRpcUrl })
  }

  // Reset rather than save today's defaults: writing them would pin them, so a
  // later change to what production means would never reach anyone who once
  // pressed this. Clearing storage leaves the app following the defaults, which
  // is what the button is asking for.
  function useProductionEndpoints() {
    endpointSwitchAttempt++
    networkSettingsStore.reset()
  }

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
  const XDAI_DECIMALS = 18
  const BZZ_DECIMALS = 16
  const AMOUNT_PRECISION = 4
  /** Stands in where the chain has no figure to give, rather than a lying zero. */
  const NO_FIGURE = '—'
  /** The assets the faucet can hand over, and how to read an amount for each. */
  const FAUCET_TOKENS = [
    { value: 'xdai', label: 'xDAI', decimals: XDAI_DECIMALS, placeholder: '0.05' },
    { value: 'bzz', label: 'BZZ', decimals: BZZ_DECIMALS, placeholder: '1' },
  ]
  let faucetTo = $state('')
  let faucetToken = $state(FAUCET_TOKENS[0].value)
  let faucetTyped = $state('0.05')
  let faucetHelpOpen = $state(false)
  let faucetBusy = $state(false)
  let faucetMessage = $state('')
  let faucetError = $state('')
  let funds = $state<{ faucet: FundsRow; recipient: FundsRow } | undefined>(undefined)
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
   * Read the amount box. Anything that is not a positive number reads as zero
   * rather than an error — a half-typed figure disables Send, it does not take
   * the panel down with it.
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

  const faucetAsset = $derived(
    FAUCET_TOKENS.find((token) => token.value === faucetToken) ?? FAUCET_TOKENS[0],
  )
  /** What Send would deliver; zero disables it. */
  const faucetValue = $derived(faucetAmount(faucetTyped, faucetAsset.decimals))
  const faucetTokenOptions = $derived(FAUCET_TOKENS.map(({ value, label }) => ({ value, label })))

  // Amounts differ by orders of magnitude between assets, so carrying the
  // previous box over is a wrong default every time; each token brings its own.
  function pickFaucetToken(value: string) {
    faucetTyped = FAUCET_TOKENS.find((token) => token.value === value)?.placeholder ?? faucetTyped
  }

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
      fundsError = ''
      return
    }
    // A balance is only meaningful as "this address, on this chain", so both
    // are pinned for the read and re-checked after it. The endpoint half is not
    // pedantry: switching chains leaves the previous one's read in flight, and
    // it used to win — mainnet figures under the "Local dev chain" banner.
    const rpcUrl = networkSettingsStore.gnosisRpcUrl
    // Untracked because this runs from an $effect: reading `funds` normally
    // would make that effect depend on what it writes. Dropping a read that
    // belongs to another address now, rather than when the new one lands,
    // is what stops the old numbers sitting under the new label meanwhile.
    if (untrack(() => funds)?.recipient.address !== requested) {
      funds = undefined
    }
    const stale = () =>
      faucetRecipient !== requested || networkSettingsStore.gnosisRpcUrl !== rpcUrl
    try {
      const read = await devChainFunds(requested, rpcUrl)
      // Typing an address fires this per keystroke and two reads can land out
      // of order — never show one address's balances under another.
      if (stale()) return
      funds = read
      fundsError = ''
    } catch (e) {
      if (stale()) return
      funds = undefined
      fundsError = e instanceof Error ? e.message : String(e)
    }
  }

  // Re-read whenever the recipient changes; the Chain tab is the only consumer,
  // so this costs nothing on a tab most sessions never open.
  $effect(() => {
    if (activeTab === 'chain' && faucetRecipient) {
      void refreshFunds()
    }
  })

  /**
   * The rows of the balances table, formatted.
   *
   * The read is only used for the address it was made for. The row is labelled
   * with the CURRENT recipient, so pairing it with the previous read's figures
   * — which is what pasting a second address did until the new read landed —
   * puts one address's balances under another's name. Both are checksummed, so
   * they compare directly.
   */
  const balanceRows = $derived.by(() => {
    const rows: { label: string; address: string; xdai: string; bzz: string }[] = []
    const shown = funds?.recipient.address === faucetRecipient ? funds : undefined
    if (faucetRecipient) {
      rows.push({
        label: 'Recipient',
        address: faucetRecipient,
        xdai: shown ? formatAmount(shown.recipient.xdai, XDAI_DECIMALS) : NO_FIGURE,
        bzz: shown ? formatAmount(shown.recipient.bzz, BZZ_DECIMALS) : NO_FIGURE,
      })
    }
    if (shown) {
      rows.push({
        label: 'Faucet',
        address: shown.faucet.address,
        xdai: formatAmount(shown.faucet.xdai, XDAI_DECIMALS),
        bzz: formatAmount(shown.faucet.bzz, BZZ_DECIMALS),
      })
    }
    return rows
  })

  async function sendFaucetFunds() {
    const to = faucetRecipient
    if (!to || faucetValue === 0n) return
    // What was actually sent, read before the send rather than after it. The
    // fields are disabled while it runs, so this is belt and braces — but a
    // receipt that reports the boxes' current contents instead of the transfer
    // is the kind of wrong that gets believed.
    const amountLabel = faucetTyped.trim()
    const assetLabel = faucetAsset.label
    faucetBusy = true
    faucetMessage = ''
    faucetError = ''
    try {
      await sendFromFaucet(to, {
        xdai: faucetToken === 'xdai' ? faucetValue : 0n,
        bzzPlur: faucetToken === 'bzz' ? faucetValue : 0n,
      })
      faucetMessage = `✅ Sent ${amountLabel} ${assetLabel} to ${to}`
    } catch (error) {
      faucetError = error instanceof Error ? error.message : String(error)
    } finally {
      faucetBusy = false
    }
    await refreshFunds()
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
  // Follows the shared network setting, like every other dev tool here —
  // reading a batch from one chain while the app talks to another is a trap,
  // and this page switches endpoints in one click. Deliberately overwrites a
  // hand-typed value when that happens: after switching chains the old one is
  // the trap, not a preference worth keeping.
  let importRpcUrl = $derived(networkSettingsStore.gnosisRpcUrl)
  // Blank → resolve from the chain the RPC serves; a value overrides.
  let importContractOverride = $state('')
  let importSetDefault = $state(true)
  let importing = $state(false)
  let importMessage = $state('')
  let importError = $state('')

  // Contract address the read will use unless the override is filled in. Every
  // chain the app supports is Gnosis or a fork of it carrying the deployment at
  // the same address, so this is one constant rather than something to resolve
  // — asking the endpoint would spend two probes per keystroke to be told what
  // is already known.
  const resolvedContract = gnosisMainnetSettings().addresses.postageStamp

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
        // Only ever an authoritative "not here" now — an endpoint that could
        // not be read throws instead, and lands in the catch below with its
        // own message.
        importError =
          'No such batch on this chain — check the batch ID, the RPC URL, or the contract address.'
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

  // Mock stamp widget settings — `devSettingsStore` is the single source of
  // truth (durable + cross-tab); the controls bind straight to its setters via
  // function bindings, so there is no local mirror to drift.
  const MOCK_RESULT_OPTIONS = [
    { value: 'success', label: 'Success (creates a drive)' },
    { value: 'error', label: 'Error (purchase failed)' },
  ]
</script>

{#snippet chainBanner(
  label: string,
  detail: string,
  alarming: boolean,
  onretry?: () => void,
)}
  <div
    class="rounded-md border px-4 py-3 text-sm {alarming
      ? 'border-destructive bg-destructive/10 text-destructive font-medium'
      : 'border-border text-muted-foreground'}"
  >
    <span>{label}</span>
    <span class="font-mono">{detail}</span>
    {#if onretry}
      <Button variant="outline" size="sm" class="ml-2 align-middle" onclick={onretry}>Retry</Button>
    {/if}
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
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-xl font-bold">Developer Tools</h2>

    <!--
      Switching environments is a rare act, so it sits in a menu rather than
      occupying the page: the trigger carries the one word worth seeing at a
      glance, and anything that is neither preset is edited through the
      product's own Network settings dialog.
    -->
    <DropdownMenu class="top-full right-0 mt-2 min-w-44 p-1">
      {#snippet trigger(props)}
        <Button variant="outline" {...props}>
          Connected to: {endpointMode}
          <ChevronDown class="size-4 shrink-0" />
        </Button>
      {/snippet}

      <DropdownMenuItem onclick={useLocalEndpoints}>
        <span class="flex-1 whitespace-nowrap">Use local</span>
      </DropdownMenuItem>
      <DropdownMenuItem onclick={useProductionEndpoints}>
        <span class="flex-1 whitespace-nowrap">Use production</span>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem onclick={() => (networkDialogOpen = true)}>
        <Settings class="size-4 shrink-0" />
        <span class="flex-1 whitespace-nowrap">Network settings</span>
      </DropdownMenuItem>
    </DropdownMenu>
  </div>

  <!--
    Which chain these tools are pointed at. Every action on this page spends,
    and a dev chain reports the same chain id as mainnet on purpose — so the
    only honest answer comes from the genesis hash. Red is for MAINNET: on this
    page that is the state nobody intends to be in.

    Keyed on the endpoint: without it a switch away from an unreachable RPC
    keeps rendering the failed branch — with the NEW url interpolated into it,
    since the message reads that from the store — so a healthy endpoint is
    reported dead the instant it is selected. The attempt counter is the other
    half: a chain that comes up after the page did needs something to re-ask,
    and nothing else here would.
  -->
  {#key `${networkSettingsStore.gnosisRpcUrl}#${chainProbeAttempt}`}
    {#await chainIdentity(networkSettingsStore.gnosisRpcUrl)}
      {@render chainBanner('Checking the chain at ', networkSettingsStore.gnosisRpcUrl, false)}
    {:then identity}
      {#if identity.kind === 'mainnet'}
        {@render chainBanner(
          'GNOSIS MAINNET — these tools spend real funds. ',
          networkSettingsStore.gnosisRpcUrl,
          true,
          retryChainProbe,
        )}
      {:else if identity.kind === 'dev'}
        {@render chainBanner(
          'Local dev chain, nothing here is real. ',
          networkSettingsStore.gnosisRpcUrl,
          false,
          retryChainProbe,
        )}
      {:else}
        <!--
          Alarming, and not the "nothing here is real" line: an endpoint that is
          reachable but not Gnosis may well be somebody's real chain, and the
          tools below refuse to run there rather than guess.
        -->
        {@render chainBanner(
          `Chain ${identity.chainId} is not Gnosis — these tools will not run against `,
          networkSettingsStore.gnosisRpcUrl,
          true,
          retryChainProbe,
        )}
      {/if}
    {:catch}
      {@render chainBanner(
        'No chain reachable at ',
        networkSettingsStore.gnosisRpcUrl,
        true,
        retryChainProbe,
      )}
    {/await}
  {/key}

  {#if networkDialogOpen}
    <NetworkSettingsDialog onclose={() => (networkDialogOpen = false)} />
  {/if}

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
        <h4 class="text-sm font-semibold">Endpoints these tools use</h4>
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
        <!--
          A second node of the bee-compose cluster, useful for checking that a
          chunk replicated off the node that took it. It only exists while the
          Bee node IS that cluster — against a gateway there is no such peer to
          link to, and a dead localhost row reads as something being broken.
        -->
        {#if sameEndpoint(networkSettingsStore.beeNodeUrl, LOCAL_BEE_NODE_URL)}
          <div class="flex items-center gap-2">
            <StatusDot endpoint={LOCAL_CLUSTER_WORKER_URL} />
            <span class="font-mono text-sm">Cluster worker:</span>
            <a
              href={LOCAL_CLUSTER_WORKER_URL}
              target="_blank"
              rel="noopener"
              class="text-primary font-mono text-sm">{LOCAL_CLUSTER_WORKER_URL}</a
            >
            <CopyButton text={LOCAL_CLUSTER_WORKER_URL} />
          </div>
        {/if}
        <div class="flex items-center gap-2">
          <StatusDot endpoint={networkSettingsStore.gnosisRpcUrl} method="json-rpc" />
          <!--
            Not labelled "(fake)": this endpoint is whatever it is configured to
            be, and the banner above says which. Asserting it here would
            contradict that banner the moment someone points at mainnet.
          -->
          <span class="font-mono text-sm">Gnosis Chain RPC:</span>
          <a
            href={networkSettingsStore.gnosisRpcUrl}
            target="_blank"
            rel="noopener"
            class="text-primary font-mono text-sm">{networkSettingsStore.gnosisRpcUrl}</a
          >
          <CopyButton text={networkSettingsStore.gnosisRpcUrl} />
        </div>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      </div>

      <div class="flex flex-col gap-2">
        <h4 class="text-sm font-semibold">Test connect flow</h4>
        <p class="text-sm">Test the connect flow with the demo app:</p>
        <div class="flex items-center gap-2">
          <StatusDot endpoint={demoAppOrigin} />
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- template literal with resolve() -->
          <a href={connectUrl} class="text-primary font-mono text-sm">localhost:3500 (demo)</a>
          <CopyButton text={connectUrl} />
        </div>
      </div>

      <div class="flex flex-col items-start gap-2">
        <h4 class="text-sm font-semibold">Local data</h4>
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
      <h3 class="text-lg font-semibold">Stored stamps (local)</h3>
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

      <h3 class="text-lg font-semibold">Manual sync testing</h3>
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
        Simulate the product <strong>Add drive</strong> flow (Storage tab / Upgrade) without a real
        cross-chain payment — the purchase widget only settles on mainnet, so this is what makes
        that flow reachable at all here. The batch it leaves behind is fabricated, which is why
        extend and resize cannot act on it; for a drive backed by a real batch, use
        <strong>Create drive to test with</strong> below.
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

      <div class="flex items-center gap-1">
        <h3 class="text-lg font-semibold">Faucet</h3>
        <Button
          variant="ghost"
          size="sm"
          aria-label="About the faucet"
          aria-expanded={faucetHelpOpen}
          onclick={() => (faucetHelpOpen = !faucetHelpOpen)}
        >
          <Info class="size-4" />
        </Button>
      </div>

      {#if faucetHelpOpen}
        <div class={CARD_CLASS}>
          <p class="text-muted-foreground text-sm">
            Hands <em>any</em> address money on the dev chain — a plain transfer from the faucet the bake
            stocked, since the BZZ pool here is real and thin and only a purchase is worth spending it
            on.
          </p>
          <p class="text-muted-foreground text-sm">
            <strong>Anvil account 0</strong> starts with 10 000 xDAI and no BZZ, which is the bake faucet's
            to give. Importing its key into MetaMask is the shortcut to a wallet that already holds something
            here.
          </p>
          {@render copyRow('Address', ANVIL_ACCOUNT.address)}
          {@render copyRow('Private key', ANVIL_ACCOUNT.privateKey)}
        </div>
      {/if}

      <div class="flex flex-col gap-2">
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Recipient</span>
          <Input bind:value={faucetTo} placeholder="0x… any address" />
        </label>
        {#if faucetTo.trim() && !faucetRecipient}
          <span class="text-destructive text-sm">Not an address.</span>
        {/if}
      </div>

      {#if fundsError}
        <p class="text-destructive text-sm">{fundsError}</p>
      {/if}
      {#if balanceRows.length}
        <div class="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-4 gap-y-1 text-sm">
          <span></span>
          <span></span>
          <span class="text-muted-foreground text-right text-xs">xDAI</span>
          <span class="text-muted-foreground text-right text-xs">BZZ</span>
          {#each balanceRows as row (row.label)}
            <span class="text-muted-foreground">{row.label}</span>
            <span class="font-mono text-xs break-all">{row.address}</span>
            <span class="text-right font-mono">{row.xdai}</span>
            <span class="text-right font-mono">{row.bzz}</span>
          {/each}
        </div>
      {:else}
        <p class="text-muted-foreground text-sm">Enter a recipient to see balances.</p>
      {/if}

      <div class="flex flex-wrap items-end gap-2">
        <!--
          Locked while a send is in flight: what these say is what the receipt
          below will report, so editing them mid-send would make it describe a
          transfer that never happened.
        -->
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Amount</span>
          <Input bind:value={faucetTyped} class="w-32" disabled={faucetBusy} />
        </label>
        <label class={LABEL_CLASS}>
          <span class={LABEL_TEXT_CLASS}>Token</span>
          <Select
            options={faucetTokenOptions}
            bind:value={faucetToken}
            class="w-32"
            disabled={faucetBusy}
            onchange={pickFaucetToken}
          />
        </label>
        <Button
          disabled={faucetBusy || !faucetRecipient || faucetValue === 0n}
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

      <h3 class="text-lg font-semibold">On-chain drive tooling</h3>
      <p class="text-muted-foreground text-sm">
        Creates a batch the account's own postage signer OWNS on chain, which the purchase widget
        cannot do off mainnet. That ownership is the point: it is what the paid drive operations
        will need once they are signed by that signer rather than by a Bee node. The batch is bought
        rather than granted — <strong>Create owned batch</strong> runs the widget's real step list against
        the local chain's BZZ pool, swapping rather than drawing on the faucet above, since the purchase
        is the one leg worth simulating faithfully.
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
        <Button
          variant="secondary"
          disabled={chainToolBusy || !selectedAccountId}
          onclick={() =>
            runChainTool('Created expiring drive', (_key, account) =>
              createExpiringTestDrive(account),
            )}
        >
          Create expiring drive
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
            The Gnosis deployment, <span class="font-mono">{resolvedContract}</span> — which the local
            chain carries at the same address. Leave blank to use it.
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
      <h3 class="text-lg font-semibold">Account devices</h3>
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
