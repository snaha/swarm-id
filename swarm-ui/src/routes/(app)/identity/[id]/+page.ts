import { redirect } from '@sveltejs/kit'
import type { PageLoad } from './$types'
import routes from '$lib/routes'

export const load: PageLoad = ({ params }) => {
	redirect(302, routes.IDENTITY_APPS(params.id))
}
