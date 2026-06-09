// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure client-side SPA: the identity UI runs entirely in the browser
// (WebAuthn, wallet signing, iframe proxy), so we disable SSR/prerender
// and let adapter-static serve the index.html fallback for every route.
export const ssr = false
export const prerender = false
