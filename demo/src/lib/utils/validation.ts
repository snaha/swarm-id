// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function validateHex(value: string, length: number, label: string): string | undefined {
  if (!value || value.length !== length) {
    return `${label} must be ${length} hex chars`
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return `${label} contains invalid hex characters`
  }
  return undefined
}
