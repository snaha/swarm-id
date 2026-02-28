<script lang="ts">
	import { onMount, onDestroy } from 'svelte'
	import { clientStore } from '$lib/stores/client.svelte'
	import { logStore } from '$lib/stores/log.svelte'
	import SafariWarning from '$lib/components/safari-warning.svelte'
	import AuthSection from '$lib/components/auth-section.svelte'
	import PostageStampInfo from '$lib/components/postage-stamp-info.svelte'
	import UploadSection from '$lib/components/upload-section.svelte'
	import DownloadSection from '$lib/components/download-section.svelte'
	import ActUploadSection from '$lib/components/act-upload-section.svelte'
	import ActDownloadSection from '$lib/components/act-download-section.svelte'
	import ActGranteesSection from '$lib/components/act-grantees-section.svelte'
	import SocSection from '$lib/components/soc-section.svelte'
	import FeedsSection from '$lib/components/feeds-section.svelte'
	import ConsoleLog from '$lib/components/console-log.svelte'

	const hasITP =
		typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent)

	let downloadReference = $state('')

	let actEncryptedRef = $state('')
	let actHistoryRef = $state('')
	let actPublisherPubKey = $state('')
	let actAddHistoryRef = $state('')

	function handleUploadResult(reference: string) {
		downloadReference = reference
	}

	function handleActUploadResult(result: {
		encryptedReference: string
		historyReference: string
		publisherPubKey: string
	}) {
		actEncryptedRef = result.encryptedReference
		actHistoryRef = result.historyReference
		actPublisherPubKey = result.publisherPubKey
		actAddHistoryRef = result.historyReference
	}

	function handleActHistoryUpdate(newHistoryRef: string) {
		actHistoryRef = newHistoryRef
		actAddHistoryRef = newHistoryRef
	}

	onMount(() => {
		logStore.log('Demo application starting...')
		clientStore.initialize()
	})

	onDestroy(() => {
		clientStore.destroy()
	})
</script>

<div class="min-h-screen p-6 md:p-10">
	<div class="mx-auto max-w-[800px] space-y-6">
		<div class="text-white mb-8">
			<h1 class="text-3xl font-bold mb-2">Swarm ID Demo</h1>
			<p class="text-white/80 leading-relaxed">
				This demo application shows how to use the Swarm ID library for authentication and Bee API
				operations.
			</p>
		</div>

		{#if hasITP}
			<SafariWarning />
		{/if}

		<AuthSection />
		<PostageStampInfo />
		<UploadSection onUploadResult={handleUploadResult} />
		<DownloadSection bind:reference={downloadReference} />
		<ActUploadSection onUploadResult={handleActUploadResult} />
		<ActDownloadSection
			bind:encryptedRef={actEncryptedRef}
			bind:historyRef={actHistoryRef}
			bind:publisherPubKey={actPublisherPubKey}
		/>
		<ActGranteesSection
			bind:historyRef={actAddHistoryRef}
			onHistoryUpdate={handleActHistoryUpdate}
		/>
		<SocSection />
		<FeedsSection />
		<ConsoleLog />
	</div>
</div>
