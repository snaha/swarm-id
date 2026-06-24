// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy shared account-state feed topic.
 *
 * The single shared snapshot feed (and its read-merge-rewrite + `verifyWon`
 * optimistic-retry publish) was retired in Phase 3a in favour of per-device
 * snapshot feeds (`device-state.ts`) discovered via the device-registry feed
 * (`device-registry.ts`). Only the topic prefix survives, so the cutover's
 * integration test can assert the old shared feed is never written.
 */

import { Topic } from "@ethersphere/bee-js"

// Topic prefix for the (retired) shared account-state feed.
export const ACCOUNT_SYNC_TOPIC_PREFIX = "swarm-id-backup-v1:account"

/** Build the legacy per-account shared-feed topic. */
export function accountSyncTopic(accountId: string): Topic {
  return Topic.fromString(`${ACCOUNT_SYNC_TOPIC_PREFIX}:${accountId}`)
}
