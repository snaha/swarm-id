# Swarm Identity Management

This project implements a cross-browser compatible authentication and identity management system for Swarm dApps.

## Architecture

The project uses an OAuth-style popup authentication flow that works across all browsers (Chrome, Firefox, Safari) without requiring the Storage Access API. See the [popup folder](./popup) for detailed documentation.

**Quick Overview**: The popup-based authentication allows dApps to securely derive app-specific secrets from a master identity, with browser-enforced storage partitioning providing cross-app isolation.

## Local Development Setup

### Prerequisites

1. **Install mkcert** (for local HTTPS certificates)

   On Linux:
   ```bash
   wget https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-amd64
   chmod +x mkcert-v1.4.4-linux-amd64
   sudo mv mkcert-v1.4.4-linux-amd64 /usr/local/bin/mkcert
   ```

   On macOS:
   ```bash
   brew install mkcert
   ```

2. **Generate SSL certificates**

   ```bash
   # Install the local CA
   mkcert -install

   # Generate certificates for local domains
   mkcert swarm-app.local swarm-id.local
   ```

   This will create:
   - `swarm-app.local+1.pem` (certificate)
   - `swarm-app.local+1-key.pem` (private key)

3. **Configure /etc/hosts**

   Add the following entries to `/etc/hosts`:
   ```
   127.0.0.1  swarm-app.local
   127.0.0.1  swarm-id.local
   ```

   Quick command (Linux/macOS):
   ```bash
   sudo bash -c 'echo "" >> /etc/hosts && echo "# Swarm local development domains" >> /etc/hosts && echo "127.0.0.1  swarm-app.local" >> /etc/hosts && echo "127.0.0.1  swarm-id.local" >> /etc/hosts'
   ```

### Starting the Development Servers

The project includes two Node.js HTTPS servers that serve content on different domains:

#### Using the start script (recommended)

```bash
./start-servers.sh
```

This convenience script:
- Checks if `/etc/hosts` is properly configured
- Starts both servers in the background
- Provides clear status messages
- Handles graceful shutdown on Ctrl+C

#### Server Details

**server-app.js** (`https://swarm-app.local:8080`)
- Serves the demo dApp pages
- Default page: `demo-iframe-storage.html`
- Includes CORS headers for cross-origin requests
- Supports all common file types (HTML, JS, CSS, JSON, images)

**server-id.js** (`https://swarm-id.local:8081`)
- Serves the identity/authentication pages
- Default page: `iframe-storage.html`
- Hosts the authentication popup and proxy iframe
- Includes Service Worker support with proper headers
- CORS configured for `swarm-app.local`

Both servers:
- Use HTTPS with mkcert-generated certificates
- Log all requests with timestamps
- Automatically handle MIME types
- Listen on `127.0.0.1` (localhost only)

### Testing the Setup

1. Start the servers:
   ```bash
   ./start-servers.sh
   ```

2. Open the demo in your browser:
   ```
   https://swarm-app.local:8080/popup/demo.html
   ```

3. **Important**: Accept the browser security warnings
   - The warnings appear because we're using self-signed certificates
   - This is safe for local development
   - Click "Advanced" → "Accept Risk and Continue" (or equivalent)
   - You may need to accept warnings for both domains

4. Test the authentication flow:
   - Click "Login with Swarm ID"
   - A popup opens on `swarm-id.local`
   - Complete authentication
   - The popup closes and you're authenticated

## Project Structure

```
.
├── popup/                  # OAuth-style popup authentication system
│   ├── auth.html          # Authentication popup UI
│   ├── proxy.html         # Hidden iframe proxy for API calls
│   ├── demo.html          # Demo dApp page
│   └── README.md          # Detailed documentation
├── bee/                   # Bee project source code
├── bee-js/                # bee-js project source code
├── swarm-cli/            # Swarm CLI tools
├── server-app.js         # HTTPS server for swarm-app.local:8080
├── server-id.js          # HTTPS server for swarm-id.local:8081
├── start-servers.sh      # Convenience script to start both servers
├── swarm-app.local+1.pem           # SSL certificate (mkcert)
└── swarm-app.local+1-key.pem       # SSL private key (mkcert)
```

## Documentation

- **[The Book of Swarm](./The-Book-of-Swarm.pdf)**: Comprehensive Swarm documentation
- **[Swarm Identity Management Proposal](./Swarm%20Identity%20Management%20Proposal.rtf)**: Identity system proposal
- **[Popup Authentication](./popup/README.md)**: Detailed technical documentation for the popup-based auth system

## Development Tips

- **TypeScript Execution**: Use `pnpx tsx` instead of `npx ts-node` to run TypeScript files
- **Browser DevTools**: Check Application → Storage to verify storage partitioning
- **CORS Issues**: Make sure you're accessing via the correct domain (not `localhost`)
- **Certificate Issues**: Regenerate certificates with `mkcert` if browsers reject them

## Troubleshooting

### Servers won't start
- Check if ports 8080 and 8081 are already in use: `lsof -i :8080 -i :8081`
- Ensure certificate files exist and are readable

### Cannot access swarm-app.local
- Verify `/etc/hosts` configuration: `grep swarm /etc/hosts`
- Clear browser DNS cache or restart browser
- Try ping: `ping swarm-app.local`

### Browser rejects certificates
- Reinstall mkcert CA: `mkcert -install`
- Regenerate certificates: `mkcert swarm-app.local swarm-id.local`
- Check certificate files exist in project root

### Authentication popup blocked
- Allow popups for `swarm-app.local` in browser settings
- Ensure popup is triggered by user action (not programmatically)

## License

MIT
