// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Developer-tools page: local-only. The root layout prerenders every static
// route (`prerender = true`), which would otherwise emit `dev.html` into the
// static build and ship the dev tooling to the GitHub Pages previews/production
// site. Opt this route out so it is never deployed — it still works on the dev
// server (`pnpm dev:ui`), which ignores prerendering.
export const prerender = false
