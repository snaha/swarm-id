// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from 'astro:content'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ schema: docsSchema() }),
}
