<script lang="ts">
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
  } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Label } from '$lib/components/ui/label'
  import { Separator } from '$lib/components/ui/separator'
  import { Switch } from '$lib/components/ui/switch'
  import FeedUpload from './feed-upload.svelte'
  import FeedDownload from './feed-download.svelte'
  import FeedManifest from './feed-manifest.svelte'

  const DEFAULT_TOPIC = '0000000000000000000000000000000000000000000000000000000000000000'

  let topic = $state(DEFAULT_TOPIC)
  let feedIndex = $state('')
  let feedAt = $state('')
  let isEpoch = $state(false)
  let isManifestCompat = $state(false)
  let feedOwner = $state('')
  let downloadAt = $state(Math.floor(Date.now() / 1000).toString())
  let encryptionKey = $state('')
  let uploadEncryptionKey = $state('')

  function handleEpochToggle(checked: boolean) {
    isEpoch = checked
    if (checked) {
      isManifestCompat = false
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Write & Read</CardTitle>
    <CardDescription>
      Sequential feeds store ordered updates (encrypted by default). Epoch feeds use timestamps for
      lookups.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    <div class="flex items-center gap-3">
      <Switch checked={isEpoch} onchange={handleEpochToggle} />
      <Label class="cursor-pointer">Use epoch feeds (off = sequential)</Label>
    </div>

    <div class="flex items-start gap-2" class:opacity-50={isEpoch}>
      <Checkbox bind:checked={isManifestCompat} id="manifest-compat" disabled={isEpoch} />
      <div>
        <Label for="manifest-compat" class="cursor-pointer">Feed manifest compatibility</Label>
        <p class="text-xs text-muted-foreground mt-1">
          Enable for /bzz/ URL access. Stores content reference in feed (two-step flow).
        </p>
      </div>
    </div>

    <h3 class="text-base font-semibold">Parameters</h3>
    <Input bind:value={topic} placeholder="Topic (64 hex chars)" />
    <Input bind:value={feedIndex} placeholder="Index (optional, integer)" />
    <Input bind:value={feedAt} placeholder="At (unix timestamp, optional)" />

    <Separator />

    <FeedUpload
      {topic}
      {isEpoch}
      {isManifestCompat}
      {feedIndex}
      {feedAt}
      {uploadEncryptionKey}
      onOwnerUpdate={(owner) => (feedOwner = owner)}
      onDownloadAtUpdate={(at) => (downloadAt = at)}
      onFeedAtClear={() => (feedAt = '')}
      onEncryptionKeyUpdate={(key) => (encryptionKey = key)}
      onUploadEncryptionKeyUpdate={(key) => (uploadEncryptionKey = key)}
    />

    <Separator />

    <FeedDownload
      {topic}
      {isEpoch}
      {isManifestCompat}
      {feedIndex}
      {downloadAt}
      {feedOwner}
      {encryptionKey}
      onDownloadAtUpdate={(at) => (downloadAt = at)}
      onEncryptionKeyUpdate={(key) => (encryptionKey = key)}
    />

    {#if isManifestCompat}
      <FeedManifest {topic} {isEpoch} {feedOwner} {feedAt} />
    {/if}
  </CardContent>
</Card>
