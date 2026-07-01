// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { DAY } from '@snaha/swarm-id'

export function daysToMs(days: number): number {
  return days * DAY
}

export function msToDays(ms: number): number {
  return Math.round(ms / DAY)
}
