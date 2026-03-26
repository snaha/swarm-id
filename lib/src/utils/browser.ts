// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Detect WebKit-based browsers (Safari on macOS, all browsers on iOS/iPadOS).
 * iOS browsers all use WebKit regardless of branding.
 */
export function isWebKit(): boolean {
  const ua = navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(ua)
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua)
  return isIOS || isSafari
}
