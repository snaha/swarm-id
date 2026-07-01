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

/**
 * Copy text to the clipboard, falling back to the legacy execCommand path
 * where the async Clipboard API is unavailable or denied (e.g. embedded
 * webviews). Returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    textarea.remove()
    return copied
  }
}

const ADDRESS_PREFIX_LENGTH = 6
const ADDRESS_SUFFIX_LENGTH = 4

/** 0x71C7...976F-style truncation for Ethereum addresses. */
export function truncateAddress(address: string): string {
  return `${address.slice(0, ADDRESS_PREFIX_LENGTH)}...${address.slice(-ADDRESS_SUFFIX_LENGTH)}`
}

export type WithElementRef<T, El extends HTMLElement = HTMLElement> = T & { ref?: El | null }
