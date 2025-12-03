#!/usr/bin/env node

/**
 * Build script for Swarm ID demo app
 *
 * - Bundles the Swarm ID library into demo HTML files
 * - Replaces hardcoded URLs with environment variables
 * - Outputs to build/ directory
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Get environment variables with defaults
const APP_DOMAIN = process.env.APP_DOMAIN || 'https://swarm-demo.snaha.net'
const ID_DOMAIN = process.env.ID_DOMAIN || 'https://swarm-id.snaha.net'

console.log('Building Swarm ID Demo App...')
console.log(`APP_DOMAIN: ${APP_DOMAIN}`)
console.log(`ID_DOMAIN: ${ID_DOMAIN}`)

// Create build directory
const buildDir = join(__dirname, 'build')
mkdirSync(buildDir, { recursive: true })

// Copy library dist files
console.log('Copying library files...')
const libDistDir = join(__dirname, '..', 'lib', 'dist')
const buildLibDir = join(buildDir, 'lib')
mkdirSync(buildLibDir, { recursive: true })
cpSync(libDistDir, buildLibDir, { recursive: true })
console.log('✓ Library files copied')

// Process demo.html and rename to index.html
console.log('Processing demo.html...')
let demoHtml = readFileSync(join(__dirname, 'demo.html'), 'utf-8')

// Inject environment config in head
const configScript = `
  <script>
    // Environment configuration
    window.__APP_DOMAIN__ = '${APP_DOMAIN}';
    window.__ID_DOMAIN__ = '${ID_DOMAIN}';
  </script>
`
demoHtml = demoHtml.replace('</head>', configScript + '</head>')

writeFileSync(join(buildDir, 'index.html'), demoHtml)
console.log('✓ index.html processed')

console.log('')
console.log('Build complete! Output in demo/build/')
console.log(`  - ${buildDir}/index.html (main demo)`)
console.log(`  - ${buildDir}/lib/ (library files)`)
console.log('')
