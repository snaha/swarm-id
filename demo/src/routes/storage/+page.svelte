<script lang="ts">
	import UploadSection from '$lib/components/upload-section.svelte'
	import DownloadSection from '$lib/components/download-section.svelte'
	import FileUploadSection from '$lib/components/file-upload-section.svelte'
	import FileDownloadSection from '$lib/components/file-download-section.svelte'

	let downloadReference = $state('')
	let fileDownloadReference = $state('')

	function handleUploadResult(reference: string) {
		downloadReference = reference
	}

	function handleFileUploadResult(reference: string) {
		fileDownloadReference = reference
	}
</script>

<div class="space-y-6">
	<div class="text-foreground">
		<h1 class="text-2xl font-bold mb-1">Upload & Download</h1>
		<p class="text-muted-foreground text-sm">
			Store data on the Swarm network and retrieve it by reference. Each upload returns a
			content-addressed hash — enable encryption to protect data in transit and at rest.
		</p>
	</div>

	<UploadSection onUploadResult={handleUploadResult} />
	<DownloadSection bind:reference={downloadReference} />

	<FileUploadSection onUploadResult={handleFileUploadResult} />
	<FileDownloadSection bind:reference={fileDownloadReference} />
</div>
