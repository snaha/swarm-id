// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Invisible-signup Safari probe, not for merging. Mirrors the real crypto:
// lib/src/utils/seed-encryption.ts (PBKDF2 600k, AES-GCM) and
// ui/src/lib/crypto/passkey.ts (PRF, rpId = hostname).
const PBKDF2_ITERATIONS = 600_000
const IV_LENGTH = 12

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
const b64u = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
const unb64u = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

function context() {
  let framed
  try {
    framed = window.top !== window
  } catch {
    framed = true
  }
  return { origin: location.origin, path: location.pathname, framed, ua: navigator.userAgent }
}

// Results reach the local app page: the iframe posts to its parent, a popup to
// its opener (the claim popup's opener is the iframe, which forwards).
function relay(entry) {
  const target = window.parent !== window ? window.parent : window.opener
  if (target) target.postMessage({ type: 'probe-report', entry }, '*')
}

function report(test, result) {
  const entry = { test, ...context(), ...result }
  const out = document.getElementById('out')
  if (out)
    out.textContent = `${test}: ${JSON.stringify(result, undefined, 2)}\n\n` + out.textContent
  relay(entry)
}

function errorInfo(e) {
  return { ok: false, errorName: e?.name, errorMessage: e?.message ?? String(e) }
}

async function passwordKey(password, salt) {
  const ikm = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encrypt(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  return hex(iv) + hex(ct)
}

async function decrypt(payloadHex, key) {
  const p = unhex(payloadHex)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: p.slice(0, IV_LENGTH) },
      key,
      p.slice(IV_LENGTH),
    ),
  )
}

async function prfSalt() {
  const s = `${location.hostname}:swarm-id-seed-encryption-v1`
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

async function createPasskey(name) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Swarm ID Safari probe', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name, displayName: name },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ],
      authenticatorSelection: {
        requireResidentKey: true,
        residentKey: 'required',
        userVerification: 'required',
      },
      extensions: { prf: { eval: { first: await prfSalt() } } },
      timeout: 60_000,
      attestation: 'none',
    },
  })
  const ext = cred.getClientExtensionResults()
  return {
    ok: true,
    credentialId: b64u(cred.rawId),
    prfEnabled: ext.prf?.enabled,
    prfOutputAtCreate: !!ext.prf?.results?.first,
  }
}

async function getPasskey(credentialId) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: credentialId ? [{ id: unb64u(credentialId), type: 'public-key' }] : [],
      extensions: { prf: { eval: { first: await prfSalt() } } },
    },
  })
  const first = cred.getClientExtensionResults().prf?.results?.first
  return {
    ok: true,
    credentialId: b64u(cred.rawId),
    prfOutput: !!first,
    prfOutputHash: first
      ? hex(await crypto.subtle.digest('SHA-256', first)).slice(0, 16)
      : undefined,
  }
}

async function storageAccess() {
  try {
    return document.hasStorageAccess ? await document.hasStorageAccess() : 'n/a'
  } catch (e) {
    return `error: ${e?.message}`
  }
}

// Read by the inline scripts of the probe pages.
Object.assign(window, {
  PBKDF2_ITERATIONS,
  hex,
  unhex,
  report,
  errorInfo,
  passwordKey,
  encrypt,
  decrypt,
  createPasskey,
  getPasskey,
  storageAccess,
})
