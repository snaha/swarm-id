<script lang="ts">
  import ActUploadSection from '$lib/components/act-upload-section.svelte'
  import ActDownloadSection from '$lib/components/act-download-section.svelte'
  import ActGranteesSection from '$lib/components/act-grantees-section.svelte'

  let actEncryptedRef = $state('')
  let actHistoryRef = $state('')
  let actPublisherPubKey = $state('')
  let actAddHistoryRef = $state('')

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
</script>

<div class="space-y-6">
  <div class="text-foreground">
    <h1 class="text-2xl font-bold mb-1">Access Control</h1>
    <p class="text-muted-foreground text-sm">
      The Access Control Trie (ACT) wraps your content in an encryption layer with a grantee list.
      Only identities you authorize can decrypt. Upload encrypted content, then manage who has
      access.
    </p>
  </div>

  <ActUploadSection onUploadResult={handleActUploadResult} />
  <ActDownloadSection
    bind:encryptedRef={actEncryptedRef}
    bind:historyRef={actHistoryRef}
    bind:publisherPubKey={actPublisherPubKey}
  />
  <ActGranteesSection bind:historyRef={actAddHistoryRef} onHistoryUpdate={handleActHistoryUpdate} />
</div>
