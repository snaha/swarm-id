<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { resolve } from '$app/paths'
  import type { RouteId } from '$app/types'
  import { Card, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card'

  const features: { href: RouteId; title: string; description: string }[] = [
    {
      href: '/storage',
      title: 'Storage',
      description:
        'The basic building block — upload data to the Swarm network and retrieve it by its content-addressed reference. Try with optional encryption.',
    },
    {
      href: '/access-control',
      title: 'Access Control',
      description:
        'Control who can read your data. Access Control Trie (ACT) lets you encrypt content and grant or revoke access to specific public keys.',
    },
    {
      href: '/soc',
      title: 'Single Owner Chunks',
      description:
        'A signed chunk tied to an owner and identifier. SOCs let you write to a deterministic address that others can look up by your public key.',
    },
    {
      href: '/feeds',
      title: 'Feeds',
      description:
        'Mutable pointers on an immutable network. Feeds let you publish updates to a fixed topic — readers always get the latest version.',
    },
  ]
</script>

<div class="space-y-8">
  <div class="text-foreground">
    <h1 class="text-3xl font-bold mb-2">Swarm ID Demo</h1>
    <p class="text-muted-foreground leading-relaxed">
      This demo shows how dApps integrate with Swarm ID for decentralized identity and data
      management. Your identity lives on a trusted domain and is never shared directly — apps
      receive derived keys scoped to their origin. Connect in the sidebar to try it out.
    </p>
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    {#each features as feature (feature.href)}
      <a href={resolve(feature.href)} class="group block">
        <Card class="h-full transition-shadow group-hover:shadow-md">
          <CardHeader>
            <CardTitle>{feature.title}</CardTitle>
            <CardDescription>{feature.description}</CardDescription>
          </CardHeader>
        </Card>
      </a>
    {/each}
  </div>
</div>
