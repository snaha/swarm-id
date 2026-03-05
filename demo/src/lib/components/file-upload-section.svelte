<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
	import { Input } from '$lib/components/ui/input'
	import { Button } from '$lib/components/ui/button'
	import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte'
	import Label from '$lib/components/ui/label/label.svelte'
	import ResultDisplay from './result-display.svelte'
	import type { ResultData } from './result-types'
	import { clientStore } from '$lib/stores/client.svelte'
	import { logStore } from '$lib/stores/log.svelte'

	interface Props {
		onUploadResult?: (reference: string) => void
	}

	let { onUploadResult }: Props = $props()

	let selectedFile: File | undefined = $state(undefined)
	let result = $state<ResultData | undefined>(undefined)
	let error = $state<string | undefined>(undefined)
	let enableEncryption = $state(true)
	let encryptManifest = $state(false)

	function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement
		selectedFile = input.files?.[0]
		result = undefined
		error = undefined
	}

	async function handleUpload() {
		result = undefined
		error = undefined

		if (!selectedFile) {
			error = 'Please select a file to upload'
			logStore.log('No file selected', 'error')
			return
		}

		try {
			const encryptionStatus = enableEncryption
				? encryptManifest
					? 'content + manifest encrypted'
					: 'content encrypted'
				: 'no encryption'
			logStore.log(
				`Uploading file: ${selectedFile.name} (${selectedFile.size} bytes, ${encryptionStatus})...`,
			)

			const uploadResult = await clientStore.client!.uploadFile(selectedFile, undefined, {
				encrypt: enableEncryption,
				encryptManifest: enableEncryption && encryptManifest,
			})

			logStore.log(`Upload successful! Reference: ${uploadResult.reference}`)

			const encryptionLabel = enableEncryption
				? encryptManifest
					? 'Content + Manifest Encrypted'
					: 'Content Encrypted'
				: 'Not Encrypted'

			result = {
				title: `File uploaded (${encryptionLabel}):`,
				entries: [
					{ label: 'Reference', value: uploadResult.reference },
					{ label: 'Filename', value: selectedFile.name },
				],
				footnote: `${uploadResult.reference.length} hex chars (${uploadResult.reference.length / 2} bytes)`,
			}
			onUploadResult?.(uploadResult.reference)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			logStore.log(`Upload failed: ${msg}`, 'error')
			error = msg
		}
	}
</script>

<Card>
	<CardHeader>
		<CardTitle>Upload File</CardTitle>
	</CardHeader>
	<CardContent class="space-y-4">
		<Input type="file" onchange={handleFileSelect} />

		{#if selectedFile}
			<p class="text-sm text-muted-foreground">
				Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
			</p>
		{/if}

		<div class="flex flex-col gap-2">
			<div class="flex items-center gap-2">
				<Checkbox id="encrypt" bind:checked={enableEncryption} />
				<Label for="encrypt">Enable encryption</Label>
			</div>
			<div class="flex items-center gap-2">
				<Checkbox
					id="encrypt-manifest"
					bind:checked={encryptManifest}
					disabled={!enableEncryption}
				/>
				<Label for="encrypt-manifest" class={!enableEncryption ? 'text-muted-foreground' : ''}
					>Encrypt manifest</Label
				>
			</div>
		</div>

		<Button onclick={handleUpload} disabled={!clientStore.canUpload || !selectedFile}>
			Upload File
		</Button>

		<ResultDisplay {result} {error} />
	</CardContent>
</Card>
