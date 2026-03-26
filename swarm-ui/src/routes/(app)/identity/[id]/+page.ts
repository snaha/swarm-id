// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redirect } from '@sveltejs/kit'
import { resolve } from '$app/paths'
import type { PageLoad } from './$types'
import routes from '$lib/routes'

export const load: PageLoad = ({ params }) => {
  redirect(302, resolve(routes.IDENTITY_APPS, { id: params.id }))
}
