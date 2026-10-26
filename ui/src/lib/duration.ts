// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { DAY } from '@snaha/swarm-id/internal'

export function daysToMs(days: number): number {
  return days * DAY
}

export function msToDays(ms: number): number {
  return Math.round(ms / DAY)
}

/** The "Keep apps connected for" choices, in days, as the select shows them. */
export const CONNECTION_DAYS_OPTIONS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]
