// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure client-side SPA: the identity UI runs entirely in the browser
// (WebAuthn, wallet signing, iframe proxy), so SSR is off. Routes are still
// prerendered as client-rendered HTML shells: GitHub Pages serves only real
// files (the adapter's index.html fallback never kicks in there), so deep
// links like /proxy and /connect would otherwise 404 in deployments.
export const ssr = false
export const prerender = true
