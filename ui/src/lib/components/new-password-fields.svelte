<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  The create-password + verify field pair shared by the account-creation access
  step and the change-method ceremony: length rule, mismatch hint, and show/hide
  toggles in one place. Callers gate their confirm on `isNewPasswordValid`.
-->
<script lang="ts" module>
  const MIN_PASSWORD_LENGTH = 8

  /** The single source of the create-password rule. */
  export function isNewPasswordValid(password: string, verify: string): boolean {
    return password.length >= MIN_PASSWORD_LENGTH && password === verify
  }
</script>

<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'

  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'

  interface Props {
    password: string
    verify: string
  }

  let { password = $bindable(), verify = $bindable() }: Props = $props()

  let showPassword = $state(false)
  let showVerify = $state(false)

  const tooShort = $derived(password.length > 0 && password.length < MIN_PASSWORD_LENGTH)
  const mismatch = $derived(verify.length > 0 && password !== verify)
</script>

{#snippet revealToggle(shown: boolean, flip: () => void)}
  <Button
    variant="ghost"
    size="icon"
    class="size-6 shrink-0 rounded-md [&_svg]:size-3.5"
    aria-label={shown ? 'Hide password' : 'Show password'}
    onclick={flip}
  >
    {#if shown}
      <EyeOff />
    {:else}
      <Eye />
    {/if}
  </Button>
{/snippet}

<div class="flex w-full flex-col gap-4">
  <div class="flex w-full flex-col gap-2">
    <label for="new-password" class="text-sm font-medium">Create new password</label>
    <div class="flex w-full items-center gap-2">
      <Input
        id="new-password"
        type={showPassword ? 'text' : 'password'}
        bind:value={password}
        autocomplete="new-password"
        aria-invalid={tooShort}
      />
      {@render revealToggle(showPassword, () => (showPassword = !showPassword))}
    </div>
    <p class={tooShort ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
      Must be at least {MIN_PASSWORD_LENGTH} characters
    </p>
  </div>

  <div class="flex w-full flex-col gap-2">
    <label for="verify-password" class="text-sm font-medium">Verify password</label>
    <div class="flex w-full items-center gap-2">
      <Input
        id="verify-password"
        type={showVerify ? 'text' : 'password'}
        bind:value={verify}
        autocomplete="new-password"
        aria-invalid={mismatch}
      />
      {@render revealToggle(showVerify, () => (showVerify = !showVerify))}
    </div>
    {#if mismatch}
      <p class="text-destructive text-xs">Passwords do not match</p>
    {/if}
  </div>
</div>
