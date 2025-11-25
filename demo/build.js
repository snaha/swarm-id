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

// Process demo.html - just inject environment config
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

writeFileSync(join(buildDir, 'demo.html'), demoHtml)
console.log('✓ demo.html processed')

// Process auth.html (if needed in the demo app)
console.log('Processing auth.html...')
let authHtml = readFileSync(join(__dirname, 'auth.html'), 'utf-8')

// Replace hardcoded URLs
authHtml = authHtml.replace(
  /const PROXY_ORIGIN = ["']https:\/\/swarm-id\.local:8081["']/g,
  `const PROXY_ORIGIN = "${ID_DOMAIN}"`
)

writeFileSync(join(buildDir, 'auth.html'), authHtml)
console.log('✓ auth.html built')

// Create index.html - provide links to both demos
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Swarm ID Demos</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
      max-width: 600px;
    }
    h1 {
      color: #667eea;
      margin-bottom: 10px;
      font-size: 32px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 16px;
    }
    .demos {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .demo-card {
      padding: 24px;
      border: 2px solid #e0e0e0;
      border-radius: 12px;
      text-decoration: none;
      color: inherit;
      transition: all 0.2s;
    }
    .demo-card:hover {
      border-color: #667eea;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    }
    .demo-card h2 {
      color: #667eea;
      font-size: 20px;
      margin-bottom: 8px;
    }
    .demo-card p {
      color: #666;
      font-size: 14px;
      line-height: 1.5;
    }
    .demo-card .badge {
      display: inline-block;
      background: #667eea;
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🐝 Swarm ID Demos</h1>
    <p class="subtitle">
      Choose a demo to explore Swarm ID authentication
    </p>

    <div class="demos">
      <a href="/demo.html" class="demo-card">
        <h2>Library Demo</h2>
        <p>
          Production-ready demo using the Swarm ID library.
          Shows authentication, data upload/download with encryption.
        </p>
        <span class="badge">Recommended</span>
      </a>

      <a href="/popup/demo.html" class="demo-card">
        <h2>Popup Flow Demo</h2>
        <p>
          Original proof-of-concept showing OAuth-style popup authentication flow.
          Manual key derivation and iframe communication.
        </p>
        <span class="badge">Experimental</span>
      </a>
    </div>
  </div>
</body>
</html>
`

writeFileSync(join(buildDir, 'index.html'), indexHtml)
console.log('✓ index.html created')

// Copy popup files to build
console.log('Copying popup demo...')
const popupDir = join(buildDir, 'popup')
mkdirSync(popupDir, { recursive: true })

// Copy all popup HTML files
const popupSourceDir = join(__dirname, '..', 'popup')
const popupFiles = ['demo.html', 'auth.html', 'proxy.html', 'key-derivation.js', 'README.md']

for (const file of popupFiles) {
  const content = readFileSync(join(popupSourceDir, file), 'utf-8')

  // Inject config into HTML files
  if (file.endsWith('.html')) {
    const withConfig = content.replace('</head>', configScript + '</head>')
    writeFileSync(join(popupDir, file), withConfig)
  } else {
    // Copy JS and MD files as-is
    writeFileSync(join(popupDir, file), content)
  }
  console.log(`✓ popup/${file} copied`)
}

console.log('')
console.log('Build complete! Output in demo/build/')
console.log(`  - ${buildDir}/index.html (redirects to demo.html)`)
console.log(`  - ${buildDir}/demo.html`)
console.log(`  - ${buildDir}/auth.html`)
console.log(`  - ${buildDir}/popup/ (popup demo)`)
console.log('')
