// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SwarmIdClient, type ConnectionInfo } from '@snaha/swarm-id'

const DEFAULT_ID_DOMAIN = 'http://localhost:5500'
const ADDRESS_PREFIX_LENGTH = 8

const iframeOrigin = new URLSearchParams(location.search).get('idDomain') ?? DEFAULT_ID_DOMAIN

const element = (id: string): HTMLElement => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`no element #${id}`)
  return found
}

function log(line: string): void {
  const item = document.createElement('li')
  item.textContent = `${new Date().toLocaleTimeString()} ${line}`
  element('log').prepend(item)
}

function render(info: ConnectionInfo): void {
  element('status').textContent = info.identity
    ? `connected as ${info.identity.name} (${info.identity.address.slice(0, ADDRESS_PREFIX_LENGTH)}…)`
    : 'not connected'
  element('site').textContent = info.identitySite ?? iframeOrigin
  element('failed').textContent = info.failedIdentitySite ?? '—'
  // What `failedIdentitySite` is for: the app can say so before any connect.
  const warning = element('failed-site')
  warning.hidden = info.failedIdentitySite === undefined
  warning.textContent = `Your identity site ${info.failedIdentitySite} is not working right now, so this app uses ${info.identitySite} instead. Connect to sign in there, or choose another identity site on the connect screen.`
  element('partitioned').textContent =
    info.storagePartitioned === undefined ? 'unknown' : String(info.storagePartitioned)
  log(
    `connectionInfo: identity=${info.identity?.name ?? '-'} site=${info.identitySite} failed=${info.failedIdentitySite ?? '-'} partitioned=${info.storagePartitioned} canUpload=${info.canUpload}`,
  )
}

const failure = (what: string) => (error: unknown) =>
  log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)

const client = new SwarmIdClient({
  iframeOrigin,
  metadata: { name: 'Swarm ID Mini', description: 'Connect-only test app' },
  containerId: 'swarm-id-button',
  buttonConfig: { connectText: 'Connect to Swarm', disconnectText: 'Disconnect' },
  onConnectionChange: render,
})

// Each handler calls the client synchronously: the click's activation is what
// lets a popup open, and it does not survive an await before `window.open`.
element('connect').onclick = () => void client.connect().catch(failure('connect()'))
element('disconnect').onclick = () => void client.disconnect().catch(failure('disconnect()'))
element('reset-site').onclick = () =>
  void client.useIdentitySite(undefined).catch(failure('useIdentitySite()'))

log(`identity site: ${iframeOrigin}`)
client.initialize().then(() => log('initialized'), failure('initialize()'))
