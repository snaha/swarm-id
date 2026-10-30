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
  import PasswordInput from '$lib/components/password-input.svelte'

  interface Props {
    password: string
    verify: string
  }

  let { password = $bindable(), verify = $bindable() }: Props = $props()

  const tooShort = $derived(password.length > 0 && password.length < MIN_PASSWORD_LENGTH)
  const mismatch = $derived(verify.length > 0 && password !== verify)
</script>

<div class="flex w-full flex-col gap-4">
  <div class="flex w-full flex-col gap-2">
    <label for="new-password" class="text-sm font-medium">Create new password</label>
    <PasswordInput
      id="new-password"
      bind:value={password}
      autocomplete="new-password"
      aria-invalid={tooShort}
    />
    <p class={tooShort ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
      Must be at least {MIN_PASSWORD_LENGTH} characters
    </p>
  </div>

  <div class="flex w-full flex-col gap-2">
    <label for="verify-password" class="text-sm font-medium">Verify password</label>
    <PasswordInput
      id="verify-password"
      bind:value={verify}
      autocomplete="new-password"
      aria-invalid={mismatch}
    />
    {#if mismatch}
      <p class="text-destructive text-xs">Passwords do not match</p>
    {/if}
  </div>
</div>
