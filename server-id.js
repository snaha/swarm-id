#!/usr/bin/env node

/**
 * Simple HTTPS server for swarm-id.local
 * Serves iframe-storage.html on port 8081
 *
 * Modes:
 * - PROXY: Set PROXY_TARGET env var to proxy to dev server (e.g., http://localhost:5173)
 * - PRODUCTION: Serve built files from swarm-ui/build/
 *
 * /demo/ and /popup/ files are always served from disk
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8081;
const HOST = 'swarm-id.local';
const PROXY_TARGET = process.env.PROXY_TARGET; // e.g., 'http://localhost:5173'

// SSL certificate options
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'swarm-app.local+1-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'swarm-app.local+1.pem'))
};

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
};

// Simple proxy function
function proxyRequest(req, res, target) {
  const url = new URL(req.url, `https://${HOST}:${PORT}`);
  const targetUrl = new URL(target);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.host
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Add CORS headers
    const headers = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': 'https://swarm-app.local:8080',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Frame-Options': 'ALLOW-FROM https://swarm-app.local:8080'
    };

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('502 Bad Gateway - Dev server not running?');
  });

  req.pipe(proxyReq);
}

const server = https.createServer(sslOptions, (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Parse URL to remove query string
  const url = new URL(req.url, `https://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // Check if requesting demo/ or popup/ files (the iframe proxy and old popup files)
  // These are always served from disk, even when proxying
  if (pathname.startsWith('/demo/') || pathname.startsWith('/popup/')) {
    const filePath = path.join(__dirname, pathname);
    serveStaticFile(req, res, filePath, pathname);
    return;
  }

  // If PROXY_TARGET is set, proxy everything else to that URL
  if (PROXY_TARGET) {
    proxyRequest(req, res, PROXY_TARGET);
    return;
  }

  // Otherwise serve from build directory
  const buildPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, 'swarm-ui', 'build', buildPath);
  serveStaticFile(req, res, filePath, pathname);
});

// Helper function to serve static files
function serveStaticFile(req, res, filePath, pathname) {
  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    let finalFilePath = filePath;

    if (err) {
      // If file not found in build directory and not a demo/popup file, serve index.html for SPA routing
      if (!pathname.startsWith('/demo/') && !pathname.startsWith('/popup/')) {
        finalFilePath = path.join(__dirname, 'swarm-ui', 'build', 'index.html');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }
    }

    // Get file extension
    const ext = path.extname(finalFilePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Read and serve file
    fs.readFile(finalFilePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
        return;
      }

      // Set CORS headers to allow cross-origin iframe embedding
      const headers = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': 'https://swarm-app.local:8080',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-Frame-Options': 'ALLOW-FROM https://swarm-app.local:8080'
      };

      // Service Worker files need special headers
      if (req.url === '/sw.js') {
        headers['Service-Worker-Allowed'] = '/';
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        console.log('[Server] Serving Service Worker with special headers');
      }

      res.writeHead(200, headers);
      res.end(content);
    });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('='.repeat(70));
  console.log(`HTTPS Server running at https://${HOST}:${PORT}/`);
  if (PROXY_TARGET) {
    console.log(`Mode: PROXY (proxying to ${PROXY_TARGET})`);
    console.log(`Make sure your dev server is running!`);
  } else {
    console.log(`Mode: PRODUCTION (serving from swarm-ui/build/)`);
  }
  console.log(`Serving /demo/ and /popup/ from disk`);
  console.log('='.repeat(70));
  console.log(`\nThis server provides the storage iframe and Service Worker for swarm-app.local\n`);
});
