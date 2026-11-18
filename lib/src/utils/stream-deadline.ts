// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How long the proxy waits on the dApp's side of a streaming transfer, from
 * the call's `requestOptions.timeout`. The client reads the same functions,
 * so its own deadlines sit just past the proxy's.
 */

import { STREAM_IDLE_TIMEOUT_MS, STREAM_SOURCE_IDLE_MAX_MS } from "./constants"
import { MAX_TIMER_DELAY_MS } from "./promise"

/**
 * How long a streaming download's reader may go without a pull: the default,
 * or a longer `requestOptions.timeout`. A shorter one bounds only the proxy's
 * own silence, on the client.
 */
export function downloadReaderIdleTimeout(perCall: number | undefined): number {
  return Math.min(
    Math.max(perCall ?? 0, STREAM_IDLE_TIMEOUT_MS),
    MAX_TIMER_DELAY_MS,
  )
}

/**
 * How long a streaming upload's source may stay silent: the default, or a
 * longer `requestOptions.timeout`, never past {@link STREAM_SOURCE_IDLE_MAX_MS}.
 * The upload holds the drive's write lock for every writer on the device
 * while it waits.
 */
export function uploadSourceIdleTimeout(perCall: number | undefined): number {
  return Math.min(
    Math.max(perCall ?? 0, STREAM_IDLE_TIMEOUT_MS),
    STREAM_SOURCE_IDLE_MAX_MS,
  )
}
