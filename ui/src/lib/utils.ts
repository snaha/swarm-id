// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Placeholder handler for interactive elements whose feature hasn't landed yet. */
export function notImplemented() {
  alert('Not implemented yet.')
}

export type WithElementRef<T, El extends HTMLElement = HTMLElement> = T & { ref?: El | null }
