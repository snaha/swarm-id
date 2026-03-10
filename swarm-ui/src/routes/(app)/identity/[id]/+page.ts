import { redirect } from '@sveltejs/kit'
import { resolve } from '$app/paths'
import type { PageLoad } from './$types'
import routes from '$lib/routes'

export const load: PageLoad = ({ params }) => {
  redirect(302, resolve(routes.IDENTITY_APPS, { id: params.id }))
}
