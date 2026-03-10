<script lang="ts">
  import Modal from '$lib/components/ui/modal.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import EthereumLogo from '$lib/components/ethereum-logo.svelte'
  import PasskeyLogo from '$lib/components/passkey-logo.svelte'
  import CloseLarge from 'carbon-icons-svelte/lib/CloseLarge.svelte'
  import Upload from 'carbon-icons-svelte/lib/Upload.svelte'
  import ErrorMessage from '$lib/components/ui/error-message.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'
  import { layoutStore } from '$lib/stores/layout.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { parseEncryptedExportHeader } from '@swarm-id/lib'

  interface Props {
    open: boolean
    onclose: () => void
  }

  let { open = $bindable(), onclose }: Props = $props()

  let isProcessing = $state(false)
  let fileError = $state<string | undefined>(undefined)
  let isDragging = $state(false)
  let fileInputRef = $state<HTMLInputElement | undefined>(undefined)

  function close() {
    isProcessing = false
    onclose()
  }

  function handlePasskeyClick() {
    close()
    goto(resolve(routes.SIGNIN_PASSKEY))
  }

  function handleEthereumClick() {
    close()
    goto(resolve(routes.SIGNIN_ETHEREUM))
  }

  function handleLocalAccountClick() {
    fileError = undefined
    fileInputRef?.click()
  }

  async function processImportFile(file: File) {
    try {
      fileError = undefined
      const text = await file.text()
      const fileData: unknown = JSON.parse(text)
      const result = parseEncryptedExportHeader(fileData)

      if (!result.success) {
        fileError = 'Invalid .swarmid file'
        return
      }

      sessionStore.setImportData(fileData, result.header)

      if (result.header.accountType === 'passkey') {
        close()
        goto(resolve(routes.IMPORT_PASSKEY))
      } else if (result.header.accountType === 'ethereum') {
        close()
        goto(resolve(routes.IMPORT_ETHEREUM))
      } else {
        fileError = `Import for ${result.header.accountType} accounts is not yet supported`
      }
    } catch {
      fileError = 'Could not read file. Make sure it is a valid .swarmid file.'
    }
  }

  function handleFileSelected(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) {
      processImportFile(file)
    }
    // Reset input so the same file can be selected again
    input.value = ''
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault()
    isDragging = true
  }

  function handleDragLeave() {
    isDragging = false
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault()
    isDragging = false
    const file = event.dataTransfer?.files[0]
    if (file) {
      processImportFile(file)
    }
  }
</script>

<input
  type="file"
  accept=".swarmid"
  class="hidden-file-input"
  bind:this={fileInputRef}
  onchange={handleFileSelected}
/>

{#if layoutStore.mobile}
  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="mobile-overlay"
      class:dragging={isDragging}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
    >
      <div class="mobile-header">
        <Typography variant="h4">Sign in</Typography>
        <Button variant="ghost" dimension="compact" onclick={close} disabled={isProcessing}>
          <CloseLarge size={20} />
        </Button>
      </div>
      <div class="mobile-content">
        <Vertical --vertical-gap="var(--half-padding)">
          <Typography>
            Select your synced account type below to sign in, or import a local account from a file.
          </Typography>
          {#if fileError}
            <ErrorMessage>{fileError}</ErrorMessage>
          {/if}
        </Vertical>
      </div>
      <Vertical class="mobile-buttons" --vertical-gap="var(--half-padding)">
        <Button variant="strong" onclick={handleEthereumClick} disabled={isProcessing} flexGrow>
          <EthereumLogo width={20} height={20} />
          Ethereum
        </Button>
        <Button variant="strong" onclick={handlePasskeyClick} disabled={isProcessing} flexGrow>
          <PasskeyLogo width={20} height={20} />
          Passkey
        </Button>
        <Button variant="ghost" onclick={handleLocalAccountClick} disabled={isProcessing} flexGrow>
          <Upload size={20} />
          Local account
        </Button>
      </Vertical>
    </div>
  {/if}
{:else}
  <Modal bind:open oncancel={close}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="modal-drop-zone"
      class:dragging={isDragging}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
    >
      <Vertical --vertical-gap="var(--padding)" style="padding: var(--double-padding)">
        <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
          <Typography variant="h4">Sign in</Typography>
          <Button variant="ghost" dimension="compact" onclick={close} disabled={isProcessing}>
            <CloseLarge size={20} />
          </Button>
        </Horizontal>
        <Vertical --vertical-gap="var(--half-padding)">
          <Typography>
            Select your synced account type below to sign in, or import a local account from a file.
          </Typography>
          {#if fileError}
            <ErrorMessage>{fileError}</ErrorMessage>
          {/if}
        </Vertical>
        <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
          <Horizontal --horizontal-gap="var(--half-padding)">
            <Button variant="strong" onclick={handleEthereumClick} disabled={isProcessing}>
              <EthereumLogo width={20} height={20} />
              Ethereum
            </Button>
            <Button variant="strong" onclick={handlePasskeyClick} disabled={isProcessing}>
              <PasskeyLogo width={20} height={20} />
              Passkey
            </Button>
          </Horizontal>
          <Button variant="ghost" onclick={handleLocalAccountClick} disabled={isProcessing}>
            <Upload size={20} />
            Local account
          </Button>
        </Horizontal>
      </Vertical>
    </div>
  </Modal>
{/if}

<style>
  .hidden-file-input {
    display: none;
  }

  .dragging {
    outline: 2px dashed var(--colors-ultra-high-50);
    outline-offset: -4px;
  }

  .mobile-overlay {
    position: fixed;
    inset: 0;
    background: var(--colors-ultra-low);
    z-index: 100;
    display: flex;
    flex-direction: column;
    padding: var(--padding);
  }

  .mobile-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .mobile-content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--double-padding);
  }

  :global(.mobile-buttons) {
    padding-bottom: var(--padding);
  }
</style>
