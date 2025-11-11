import type { AuthOptions } from './types'
import { deriveSecret, generateMasterKey } from './utils/key-derivation'

/**
 * Swarm ID Auth - Runs in the authentication popup
 *
 * Responsibilities:
 * - Load or generate master identity
 * - Derive app-specific secrets
 * - Send secrets to iframe via postMessage
 * - Manage master key storage
 */
export class SwarmIdAuth {
  private appOrigin: string | undefined
  private masterKey: string | undefined
  private masterKeyStorageKey: string

  constructor(options: AuthOptions = {}) {
    this.masterKeyStorageKey = options.masterKeyStorageKey || 'swarm-master-key'
  }

  /**
   * Initialize the auth popup
   */
  async initialize(): Promise<void> {
    // Security: Validate that opener is from our own origin
    if (!window.opener) {
      throw new Error('No opener window found. This page must be opened by Swarm ID iframe.')
    }

    // Check opener origin by trying to access its location
    try {
      const openerOrigin = (window.opener as Window).location.origin
      if (openerOrigin !== window.location.origin) {
        throw new Error(`Opener origin (${openerOrigin}) does not match expected origin`)
      }
      console.log('[Auth] Security: Opener origin validated ✓')
    } catch {
      // If we can't access opener.location, it's cross-origin - this is suspicious
      throw new Error('Cannot verify opener origin - cross-origin access denied')
    }

    // Get app origin from URL parameter
    const urlParams = new URLSearchParams(window.location.search)
    this.appOrigin = urlParams.get('origin') ?? undefined

    if (!this.appOrigin) {
      throw new Error('No origin parameter found in URL')
    }

    console.log('[Auth] Got app origin from URL parameter:', this.appOrigin)

    // Load master key
    this.masterKey = localStorage.getItem(this.masterKeyStorageKey) ?? undefined

    if (!this.masterKey) {
      console.log('[Auth] No master key found')
    } else {
      console.log('[Auth] Master key loaded from localStorage')
    }
  }

  /**
   * Get the app origin
   */
  getAppOrigin(): string | undefined {
    return this.appOrigin
  }

  /**
   * Get the master key (for display purposes, should be truncated)
   */
  getMasterKey(): string | undefined {
    return this.masterKey
  }

  /**
   * Check if master key exists
   */
  hasMasterKey(): boolean {
    return this.masterKey !== undefined
  }

  /**
   * Setup new identity (generate and store master key)
   */
  async setupNewIdentity(): Promise<string> {
    console.log('[Auth] Setting up new identity...')

    const newMasterKey = await generateMasterKey()
    localStorage.setItem(this.masterKeyStorageKey, newMasterKey)
    this.masterKey = newMasterKey

    console.log('[Auth] New master key generated and stored')
    return newMasterKey
  }

  /**
   * Authenticate - derive app-specific secret and send to iframe
   */
  async authenticate(): Promise<void> {
    if (!this.masterKey) {
      throw new Error('No master key available. Please set up an identity first.')
    }

    if (!this.appOrigin) {
      throw new Error('Unknown app origin. Cannot authenticate.')
    }

    console.log('[Auth] Starting authentication for app:', this.appOrigin)

    // Derive app-specific secret
    const appSecret = await deriveSecret(this.masterKey, this.appOrigin)
    console.log('[Auth] App secret derived:', appSecret.substring(0, 16) + '...')

    // Send secret to opener (the iframe that opened this popup)
    if (!window.opener || (window.opener as Window).closed) {
      throw new Error('Opener window not available')
    }

    console.log('[Auth] Sending secret to iframe...');

    // Send secret to iframe via postMessage
    (window.opener as WindowProxy).postMessage(
      {
        type: 'setSecret',
        appOrigin: this.appOrigin,
        secret: appSecret,
      },
      window.location.origin // Target the iframe's origin (same as this popup)
    )

    console.log('[Auth] Secret sent to iframe')
  }

  /**
   * Close the popup window
   */
  close(delay: number = 1500): void {
    setTimeout(() => {
      window.close()
    }, delay)
  }
}

/**
 * Initialize auth popup (called from HTML page)
 */
export async function initAuth(options?: AuthOptions): Promise<SwarmIdAuth> {
  const auth = new SwarmIdAuth(options)
  await auth.initialize()
  return auth
}
