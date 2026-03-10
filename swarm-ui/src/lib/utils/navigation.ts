import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import routes from '$lib/routes'
import { sessionStore } from '$lib/stores/session.svelte'

export function navigateToConnectOrHome() {
  if (sessionStore.data.appOrigin) {
    goto(resolve(routes.CONNECT))
  } else {
    sessionStore.clearTemporaryMasterKey()
    goto(resolve(routes.HOME))
  }
}
