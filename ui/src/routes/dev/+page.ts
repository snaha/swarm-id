// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Developer-tools page: local-only. A shipped build swaps this module and the
// page beside it for `page.production.*` (see `stubDevOnlyModules` in
// `vite.config.ts`), which answers 404 — this file is only ever what the dev
// server (`pnpm dev:ui`) runs.
//
// Opting out of prerendering keeps a `dev.html` out of the static output. It
// does NOT keep the route off a deployment on its own: the adapter's
// `index.html` fallback serves any path where the host has a catch-all, and
// the client router loads the route's chunk from there. That is what the swap
// is for.
export const prerender = false
