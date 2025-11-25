#!/usr/bin/env node

/**
 * Build script for Swarm ID app (swarm-id.snaha.net)
 *
 * - Builds SvelteKit app
 * - Bundles library into proxy.html and auth.html
 * - Injects environment configuration
 * - Outputs to swarm-id-build/ directory
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Get environment variables with defaults
const APP_DOMAIN = process.env.APP_DOMAIN || 'https://swarm-demo.snaha.net'
const ID_DOMAIN = process.env.ID_DOMAIN || 'https://swarm-id.snaha.net'
const BEE_API_URL = process.env.BEE_API_URL || 'http://localhost:1633'

console.log('Building Swarm ID App...')
console.log(`APP_DOMAIN: ${APP_DOMAIN}`)
console.log(`ID_DOMAIN: ${ID_DOMAIN}`)
console.log(`BEE_API_URL: ${BEE_API_URL}`)

// Create output directory
const outputDir = join(__dirname, 'swarm-id-build')
mkdirSync(outputDir, { recursive: true })

// Copy SvelteKit build
console.log('Copying SvelteKit build...')
const svelteKitBuildDir = join(__dirname, 'swarm-ui', 'build')
cpSync(svelteKitBuildDir, outputDir, { recursive: true })
console.log('✓ SvelteKit build copied')

// Copy library dist files
console.log('Copying library files...')
const libDistDir = join(__dirname, 'lib', 'dist')
const outputLibDir = join(outputDir, 'lib')
mkdirSync(outputLibDir, { recursive: true })
cpSync(libDistDir, outputLibDir, { recursive: true })
console.log('✓ Library files copied')

// Create demo directory for HTML files
const proxyDir = join(outputDir, 'demo')
mkdirSync(proxyDir, { recursive: true })

// Process proxy.html - just inject environment config
console.log('Processing proxy.html...')
let proxyHtml = readFileSync(join(__dirname, 'demo', 'proxy.html'), 'utf-8')

// Inject environment config before closing </head> tag
const configScript = `
    <script>
      // Environment configuration
      window.__APP_DOMAIN__ = '${APP_DOMAIN}';
      window.__ID_DOMAIN__ = '${ID_DOMAIN}';
      window.__BEE_API_URL__ = '${BEE_API_URL}';
    </script>
  </head>`

proxyHtml = proxyHtml.replace('</head>', configScript)

writeFileSync(join(proxyDir, 'proxy.html'), proxyHtml)
console.log('✓ proxy.html processed')

// Process auth.html - just inject environment config
console.log('Processing auth.html...')
let authHtml = readFileSync(join(__dirname, 'demo', 'auth.html'), 'utf-8')

// Inject environment config (reuse the same configScript)
authHtml = authHtml.replace('</head>', configScript)

writeFileSync(join(proxyDir, 'auth.html'), authHtml)
console.log('✓ auth.html processed')

console.log('')
console.log('Build complete! Output in swarm-id-build/')
console.log(`  - ${outputDir}/ (SvelteKit app)`)
console.log(`  - ${proxyDir}/proxy.html`)
console.log(`  - ${proxyDir}/auth.html`)
