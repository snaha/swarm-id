import { PUBLIC_ID_DOMAIN } from '$env/static/public'

export function resolveProxyOrigin(): string {
  const urlParams = new URLSearchParams(window.location.search)
  const override = urlParams.get('idDomain')
  if (override) return override

  if (PUBLIC_ID_DOMAIN) return PUBLIC_ID_DOMAIN

  const { hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:5174'
  }

  return 'https://swarm-id.snaha.net'
}
