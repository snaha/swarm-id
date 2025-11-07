#!/usr/bin/env node

/**
 * Simple HTTPS server for swarm-app.local
 * Serves demo-iframe-storage.html on port 8080
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const HOST = 'swarm-app.local';

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

  // Default to index or demo page
  let filePath = req.url === '/' ? '/demo-iframe-storage.html' : req.url;
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

      // Set CORS headers to allow iframe embedding
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end(content);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('='.repeat(70));
  console.log(`HTTPS Server running at https://${HOST}:${PORT}/`);
  console.log(`Serving: demo-iframe-storage.html`);
  console.log('='.repeat(70));
  console.log(`\nAccess the app at: https://${HOST}:${PORT}/demo-iframe-storage.html\n`);
});
