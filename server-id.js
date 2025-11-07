#!/usr/bin/env node

/**
 * Simple HTTPS server for swarm-id.local
 * Serves iframe-storage.html on port 8081
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8081;
const HOST = 'swarm-id.local';

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

const server = https.createServer(sslOptions, (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Parse URL to remove query string
  const url = new URL(req.url, `https://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // Default to iframe-storage.html
  let filePath = pathname === '/' ? '/iframe-storage.html' : pathname;
  filePath = path.join(__dirname, filePath);

  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    // Get file extension
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Read and serve file
    fs.readFile(filePath, (err, content) => {
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
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('='.repeat(70));
  console.log(`HTTPS Server running at https://${HOST}:${PORT}/`);
  console.log(`Serving: iframe-storage.html, sw.js`);
  console.log('='.repeat(70));
  console.log(`\nThis server provides the storage iframe and Service Worker for swarm-app.local\n`);
});
