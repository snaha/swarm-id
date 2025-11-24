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

// Read library bundles
const proxyLibPath = join(__dirname, 'lib', 'dist', 'swarm-id-proxy.js')
const authLibPath = join(__dirname, 'lib', 'dist', 'swarm-id-auth.js')
const proxyLibCode = readFileSync(proxyLibPath, 'utf-8')
const authLibCode = readFileSync(authLibPath, 'utf-8')

// Create demo directory for proxy files
const proxyDir = join(outputDir, 'demo')
mkdirSync(proxyDir, { recursive: true })

// Process proxy.html
console.log('Processing proxy.html...')
let proxyHtml = readFileSync(join(__dirname, 'demo', 'proxy.html'), 'utf-8')

// Inject environment config
const configScript = `
    <script>
      // Environment configuration
      window.__APP_DOMAIN__ = '${APP_DOMAIN}';
      window.__ID_DOMAIN__ = '${ID_DOMAIN}';
      window.__BEE_API_URL__ = '${BEE_API_URL}';
    </script>
`

// Replace library import with inline bundled code
proxyHtml = proxyHtml.replace(
  /<script type="module">\s*import \{ initProxy \} from ['"]\.\.\/lib\/dist\/swarm-id-proxy\.js['"];?\s*/s,
  configScript + `<script type="module">
// Bundled Swarm ID Proxy Library
${proxyLibCode}

const { initProxy } = window.SwarmIdProxy || {};
if (!initProxy) {
  console.error('[Proxy] Library not loaded correctly');
}
`
)

writeFileSync(join(proxyDir, 'proxy.html'), proxyHtml)
console.log('✓ proxy.html built')

// Process auth.html
console.log('Processing auth.html...')
let authHtml = readFileSync(join(__dirname, 'demo', 'auth.html'), 'utf-8')

// Check if auth.html imports the library
if (authHtml.includes('swarm-id-auth.js')) {
  authHtml = authHtml.replace(
    /<script type="module">\s*import.*?from ['"]\.\.\/lib\/dist\/swarm-id-auth\.js['"];?\s*/s,
    configScript + `<script type="module">
// Bundled Swarm ID Auth Library
${authLibCode}
`
  )
} else {
  // Just inject config if no library import
  authHtml = authHtml.replace('</head>', configScript + '</head>')
}

writeFileSync(join(proxyDir, 'auth.html'), authHtml)
console.log('✓ auth.html built')

console.log('')
console.log('Build complete! Output in swarm-id-build/')
console.log(`  - ${outputDir}/ (SvelteKit app)`)
console.log(`  - ${proxyDir}/proxy.html`)
console.log(`  - ${proxyDir}/auth.html`)
