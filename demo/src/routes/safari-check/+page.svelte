<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  The real-Safari smoke test (#584), built to be run by hand on a physical
  iPhone against the DigitalOcean deployment — the only cross-site rig there is
  (GitHub Pages serves both apps from one origin, so nothing partitions there).

  Everything is on screen because nothing else can be: Safari on iOS has no web
  inspector without a Mac and a cable, so a page that logged its findings to the
  console would be a page with no findings.
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { formatReport, runChecks } from '$lib/utils/safari-check'
  import type { CheckInput } from '$lib/utils/safari-check'
  import { resolveProxyOrigin } from '$lib/utils/environment'

  /** This page's own (first-party) record of what earlier loads saw. */
  const SEEN_KEY = 'safari-check-device'
  const LOADS_KEY = 'safari-check-loads'
  const TEST_PAYLOAD = 'swarm-id safari check'

  let previousDeviceId = $state<string | undefined>(undefined)
  let loadsSinceFirstSeen = $state(0)
  let uploadRoundTrip = $state<'ok' | 'failed' | undefined>(undefined)
  let uploading = $state(false)
  let reference = $state<string | undefined>(undefined)
  let copied = $state(false)

  const input = $derived<CheckInput>({
    connection: clientStore.authenticated
      ? {
          canUpload: clientStore.canUpload,
          storagePartitioned: clientStore.storagePartitioned,
          uploadMode: clientStore.uploadMode,
          deviceId: clientStore.deviceId,
        }
      : undefined,
    previousDeviceId,
    loadsSinceFirstSeen,
    uploadRoundTrip,
  })
  const results = $derived(runChecks(input))

  const environment = $derived({
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    dAppOrigin: typeof location === 'undefined' ? 'unknown' : location.origin,
    identityOrigin: resolveProxyOrigin(),
    deviceId: clientStore.deviceId ?? '(none yet)',
    loads: String(loadsSinceFirstSeen),
  })

  onMount(() => {
    // Read BEFORE this load's id arrives, so the comparison is against what an
    // earlier load recorded rather than against itself.
    previousDeviceId = localStorage.getItem(SEEN_KEY) ?? undefined
    loadsSinceFirstSeen = Number(localStorage.getItem(LOADS_KEY) ?? '0') + 1
    localStorage.setItem(LOADS_KEY, String(loadsSinceFirstSeen))
  })

  // Record this load's id only once it is known, so a reload has something to
  // compare against next time.
  $effect(() => {
    const id = clientStore.deviceId
    if (id) localStorage.setItem(SEEN_KEY, id)
  })

  async function connect() {
    await clientStore.client?.connect()
  }

  async function runUpload() {
    const client = clientStore.client
    if (!client) return
    uploading = true
    uploadRoundTrip = undefined
    try {
      const result = await client.uploadData(new TextEncoder().encode(TEST_PAYLOAD))
      reference = result.reference
      const back = await client.downloadData(result.reference)
      const text = new TextDecoder().decode(back)
      uploadRoundTrip = text === TEST_PAYLOAD ? 'ok' : 'failed'
      logStore.log(`Safari check: round trip ${uploadRoundTrip} (${result.reference})`)
    } catch (error) {
      uploadRoundTrip = 'failed'
      logStore.log(`Safari check: upload failed — ${String(error)}`)
    } finally {
      uploading = false
    }
  }

  async function copyReport() {
    await navigator.clipboard.writeText(formatReport(results, environment))
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

  function resetHistory() {
    localStorage.removeItem(SEEN_KEY)
    localStorage.removeItem(LOADS_KEY)
    previousDeviceId = undefined
    loadsSinceFirstSeen = 0
  }
</script>

<div class="space-y-6">
  <div class="text-foreground">
    <h1 class="mb-1 text-2xl font-bold">Safari check</h1>
    <p class="text-sm text-muted-foreground">
      Run this on a real iPhone, on the deployed site (not a preview — GitHub Pages serves both apps
      from one origin, so nothing partitions there). Connect, upload, then reload a few times and
      come back tomorrow.
    </p>
  </div>

  <div class="space-y-3">
    {#each results as result (result.id)}
      <div
        class="rounded-lg border p-4"
        class:border-green-500={result.verdict === 'pass'}
        class:border-red-500={result.verdict === 'fail'}
        class:border-border={result.verdict === 'unknown'}
      >
        <div class="flex items-center gap-2">
          <span class="text-lg" aria-hidden="true">
            {result.verdict === 'pass' ? '✅' : result.verdict === 'fail' ? '❌' : '❔'}
          </span>
          <span class="font-semibold text-foreground">{result.title}</span>
        </div>
        <p class="mt-1 text-sm text-muted-foreground">{result.detail}</p>
      </div>
    {/each}
  </div>

  <div class="flex flex-wrap gap-2">
    {#if !clientStore.authenticated}
      <button
        class="rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground"
        onclick={connect}
      >
        Connect
      </button>
    {/if}
    <button
      class="rounded-md border border-border px-4 py-3 font-medium text-foreground disabled:opacity-50"
      onclick={runUpload}
      disabled={!clientStore.canUpload || uploading}
    >
      {uploading ? 'Uploading…' : 'Upload & read back'}
    </button>
    <button
      class="rounded-md border border-border px-4 py-3 font-medium text-foreground"
      onclick={copyReport}
    >
      {copied ? 'Copied' : 'Copy report'}
    </button>
    <button
      class="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground"
      onclick={resetHistory}
    >
      Reset history
    </button>
  </div>

  <div class="rounded-lg border border-border p-4 text-xs break-all text-muted-foreground">
    {#each Object.entries(environment) as [key, value] (key)}
      <div><span class="font-semibold">{key}:</span> {value}</div>
    {/each}
    {#if reference}
      <div><span class="font-semibold">reference:</span> {reference}</div>
    {/if}
  </div>

  <details class="rounded-lg border border-border p-4 text-sm text-muted-foreground">
    <summary class="cursor-pointer font-semibold text-foreground">How to run it</summary>
    <ol class="mt-2 list-decimal space-y-1 pl-5">
      <li>Open this page on the iPhone, in normal (non-private) Safari.</li>
      <li>Tap <strong>Connect</strong> and complete the popup on the identity site.</li>
      <li>Tap <strong>Upload &amp; read back</strong>.</li>
      <li>Reload this page. The device-id check turns green or red on the second load.</li>
      <li>
        Repeat in a <strong>Private</strong> tab — the session is expected to be ephemeral there, so a
        fresh device id is the correct answer, not a failure.
      </li>
      <li>Come back after a few days: that is what the ~30-day eviction window needs.</li>
      <li>Tap <strong>Copy report</strong> and paste it back.</li>
    </ol>
  </details>
</div>
