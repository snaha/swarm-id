// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const routes = {
  ROOT: '/' as const,
  HOME: '/(app)/home' as const,
  CONNECT: '/(app)/connect' as const,
  ACCOUNT_NEW: '/(app)/account/new' as const,
  PASSKEY_NEW: '/(app)/(create)/passkey/new' as const,
  ETH_NEW: '/(app)/(create)/eth/new' as const,
  AGENT_NEW: '/(app)/(create)/agent/new' as const,
  STAMPS_ACCOUNT_NEW: '/(app)/(create)/stamps/account/new' as const,
  ACCOUNT: '/(app)/account/[id]' as const,
  ACCOUNT_APPS: '/(app)/account/[id]/apps' as const,
  ACCOUNT_STAMPS: '/(app)/account/[id]/stamps' as const,
  ACCOUNT_STAMPS_NEW: '/(app)/account/[id]/stamps/new' as const,
  ACCOUNT_SETTINGS: '/(app)/account/[id]/settings' as const,
  SIGNIN_PASSKEY: '/(app)/(create)/signin/passkey' as const,
  SIGNIN_ETHEREUM: '/(app)/(create)/signin/ethereum' as const,
  IMPORT_PASSKEY: '/(app)/(create)/import/passkey' as const,
  IMPORT_ETHEREUM: '/(app)/(create)/import/ethereum' as const,
}

export default routes
