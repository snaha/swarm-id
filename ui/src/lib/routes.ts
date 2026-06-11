// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Central route map — always navigate via these constants, never raw strings. */
const routes = {
  ROOT: '/' as const,
  CONNECT: '/connect' as const,
  HOME: '/home' as const,
  ACCOUNT_NEW: '/account/new' as const,
  ACCOUNT_NEW_PHRASE: '/account/new/phrase' as const,
  ACCOUNT_NEW_ACCESS: '/account/new/access' as const,
  ACCOUNT_NEW_DONE: '/account/new/done' as const,
  ACCOUNT_READY: '/account/ready' as const,
  ACCOUNT_IMPORT: '/account/import' as const,
  ACCOUNT_RESTORE: '/account/restore' as const,
}

export default routes
