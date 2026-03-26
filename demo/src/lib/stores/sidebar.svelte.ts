// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

let mobileOpen = $state(false)

export const sidebarStore = {
  get mobileOpen() {
    return mobileOpen
  },
  openMobile() {
    mobileOpen = true
  },
  closeMobile() {
    mobileOpen = false
  },
  toggleMobile() {
    mobileOpen = !mobileOpen
  },
}
