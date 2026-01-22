#!/usr/bin/env node

/**
 * Simple HTTPS/HTTP server for swarm-app.local
 * Serves demo files on:
 *   - HTTPS port 8080 (for local .local domain testing)
 *   - HTTP port 18080 (for SSH tunnel / nginx proxy)
 */

import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT_HTTPS = 8080
const PORT_HTTP = 18080
const HOST = 'swarm-app.local'

// SSL certificate options
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'swarm-app.local+1-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'swarm-app.local+1.pem'))
}

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

// Shared request handler
function requestHandler(req, res) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)

  // Parse URL to get pathname (strip query string)
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  // Default to demo.html
  let filePath = pathname === '/' ? '/demo/demo.html' : pathname

  // Map /lib/* to lib/dist/* for local development
  // This allows HTML files to use production-style imports without building
  if (filePath.startsWith('/lib/')) {
    filePath = filePath.replace('/lib/', '/lib/dist/')
  }

  filePath = path.join(__dirname, filePath)

  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404 Not Found')
      return
    }

    // Get file extension
    const ext = path.extname(filePath)
    const contentType = mimeTypes[ext] || 'application/octet-stream'

    // Read and serve file
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('500 Internal Server Error')
        return
      }

      // Set CORS headers to allow iframe embedding
      const headers = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }

      // Disable caching for HTML and JS files during development
      if (ext === '.html' || ext === '.js') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        headers['Pragma'] = 'no-cache'
        headers['Expires'] = '0'
      }

      res.writeHead(200, headers)
      res.end(content)
    })
  })
}

// HTTPS server for local .local domain testing
const httpsServer = https.createServer(sslOptions, requestHandler)
httpsServer.listen(PORT_HTTPS, '127.0.0.1', () => {
  console.log(`HTTPS Server running at https://${HOST}:${PORT_HTTPS}/`)
})

// HTTP server for SSH tunnel (nginx proxies to this)
const httpServer = http.createServer(requestHandler)
httpServer.listen(PORT_HTTP, '127.0.0.1', () => {
  console.log(`HTTP Server running at http://127.0.0.1:${PORT_HTTP}/`)
})

console.log('='.repeat(70))
console.log('Serving: demo/ and root files')
console.log('='.repeat(70))
console.log(`\nLocal access:  https://${HOST}:${PORT_HTTPS}/`)
console.log(`SSH tunnel:    http://127.0.0.1:${PORT_HTTP}/\n`)
