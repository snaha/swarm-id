<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import PreAuthSettingsMenu from '$lib/components/pre-auth-settings-menu.svelte'

  let { children } = $props()
</script>

<div class="page-wrapper">
  <div class="settings-menu">
    <PreAuthSettingsMenu />
  </div>
  <div class="page-content">
    <div class="content-area">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .page-wrapper {
    display: flex;
    flex-direction: row;
    min-height: 100vh;
    background: var(--colors-ultra-low);
    position: relative;
    align-items: stretch;
    justify-content: space-around;
  }

  .page-content {
    flex: 1;
    display: flex;
    justify-content: center;
    flex-direction: column;
    align-items: center;
    padding: var(--double-padding);
  }

  .content-area {
    max-width: 560px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    width: 100%;
  }

  .settings-menu {
    position: absolute;
    top: var(--double-padding);
    right: var(--double-padding);
    z-index: 10;
  }

  @media screen and (max-width: 640px) {
    .page-content {
      padding: var(--padding);
    }

    .content-area {
      flex: 1;
    }

    .settings-menu {
      top: var(--padding);
      right: var(--padding);
    }
  }
</style>
