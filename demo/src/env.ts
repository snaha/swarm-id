// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineEnvVars } from '@sveltejs/kit/env'

// A variable with no schema must be set; every one here is optional.
const optional = (value: string | undefined) => value

/**
 * The build-time variables the app reads from `$app/env/public`. Each is
 * `public` (client code may read it) and `static` (inlined by `vite build`).
 */
export const variables = defineEnvVars({
  PUBLIC_ID_DOMAIN: { public: true, static: true, schema: optional },
})
