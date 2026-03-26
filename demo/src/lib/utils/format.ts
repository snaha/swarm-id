// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const KILO = 1024

export function formatBytes(bytes: number): string {
  let unitIndex = 0
  let value = bytes
  while (value >= KILO && unitIndex < UNITS.length - 1) {
    value /= KILO
    unitIndex++
  }
  if (unitIndex === 0) return `${value} ${UNITS[unitIndex]}`
  return `${value.toFixed(unitIndex === 1 ? 1 : 2)} ${UNITS[unitIndex]}`
}
