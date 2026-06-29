<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Modal from '$lib/components/ui/modal.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import ErrorMessage from '$lib/components/ui/error-message.svelte'
  import CloseLarge from 'carbon-icons-svelte/lib/CloseLarge.svelte'

  interface Props {
    open?: boolean
    title?: string
    description?: string
    confirmLabel?: string
    // The caller authenticates with the password and closes the modal on
    // success (`open = false`), or reports a failure via `error` to keep it
    // open. `busy` disables the inputs while that async check runs.
    onSubmit?: (password: string) => void
    onCancel?: () => void
    error?: string
    busy?: boolean
  }

  let {
    open = $bindable(false),
    title = 'Enter password',
    description = 'Enter your account password to continue.',
    confirmLabel = 'Unlock',
    onSubmit,
    onCancel,
    error,
    busy = false,
  }: Props = $props()

  let password = $state('')

  const isFormValid = $derived(password.length > 0 && !busy)

  function handleSubmit() {
    if (!isFormValid) return
    onSubmit?.(password)
  }

  function handleClose() {
    if (busy) return
    password = ''
    onCancel?.()
    open = false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && isFormValid) {
      event.preventDefault()
      handleSubmit()
    }
  }

  $effect(() => {
    if (open) {
      // Reset the entered password whenever the modal (re)opens.
      password = ''
    }
  })
</script>

<Modal bind:open>
  <Vertical --vertical-gap="var(--padding)" style="padding: var(--padding)">
    <Horizontal --horizontal-justify-content="space-between">
      <Typography variant="h5">{title}</Typography>
      <Button variant="ghost" dimension="compact" onclick={handleClose} disabled={busy}
        ><CloseLarge size={20} /></Button
      >
    </Horizontal>

    <Typography>{description}</Typography>

    <Input
      type="password"
      name="account-password"
      bind:value={password}
      placeholder="Enter your password"
      disabled={busy}
      autofocus
      onkeydown={handleKeydown}
    />

    {#if error}
      <ErrorMessage>{error}</ErrorMessage>
    {/if}

    <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-justify-content="flex-end">
      <Button dimension="compact" variant="ghost" onclick={handleClose} disabled={busy}
        >Cancel</Button
      >
      <Button dimension="compact" onclick={handleSubmit} disabled={!isFormValid}
        >{confirmLabel}</Button
      >
    </Horizontal>
  </Vertical>
</Modal>
