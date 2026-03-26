// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function notImplemented(e: Event) {
  e.preventDefault()
  e.stopPropagation()
  alert('Not implemented!')
}
