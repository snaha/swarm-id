// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'

export const MOBILE_BREAKPOINT = 640

export interface LayoutStore {
  mobile: boolean
}

function withLayoutStore(): LayoutStore {
  let mobile = $state(checkMobile())

  if (browser) {
    window.addEventListener('resize', () => {
      mobile = checkMobile()
    })
  }

  function checkMobile() {
    return browser && window.innerWidth <= MOBILE_BREAKPOINT
  }

  return {
    get mobile() {
      return mobile
    },
    set mobile(value: boolean) {
      mobile = value
    },
  }
}

export const layoutStore = withLayoutStore()
