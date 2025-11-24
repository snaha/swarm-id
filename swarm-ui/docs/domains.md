# Domain Configuration

This file documents all domain configurations for easy updates across the project.

## Production Domains

| Service     | Domain                 | Description                             |
| ----------- | ---------------------- | --------------------------------------- |
| Demo App    | `demo.swarm.snaha.net` | Serves demo pages and library files     |
| Identity UI | `id.swarm.snaha.net`   | Serves SvelteKit identity management UI |

## Development Domains

| Service     | Domain            | Port | Description                        |
| ----------- | ----------------- | ---- | ---------------------------------- |
| Demo App    | `swarm-app.local` | 8080 | Local HTTPS server for demo        |
| Identity UI | `swarm-id.local`  | 8081 | Local HTTPS server for identity UI |

## GitHub Auto-Deploy

Both apps are configured for automatic deployment from GitHub:

**Repository:** `snaha/swarm-id-explorations`
**Branch:** `main` (change in the YAML files if needed)
**Deploy on push:** Enabled

When you push to the configured branch, DigitalOcean will automatically:

1. Pull the latest code
2. Run the build command
3. Deploy the static files

## Where to Update

### 1. DigitalOcean App Configs

Config files are in the **repository root** (not in swarm-ui/docs/).

**Demo App** (`../../.do-app-demo.yaml`):

```yaml
cors:
  allow_origins:
    - exact: https://id.swarm.snaha.net # UPDATE THIS

envs:
  - key: APP_DOMAIN
    value: demo.swarm.snaha.net # UPDATE THIS
  - key: ID_DOMAIN
    value: id.swarm.snaha.net # UPDATE THIS
```

**Identity UI** (`../../.do-app-id.yaml`):

```yaml
cors:
  allow_origins:
    - exact: https://demo.swarm.snaha.net # UPDATE THIS

headers:
  - pattern: /*
    headers:
      X-Frame-Options: ALLOW-FROM https://demo.swarm.snaha.net # UPDATE THIS
      Content-Security-Policy: 'frame-ancestors https://demo.swarm.snaha.net' # UPDATE THIS

envs:
  - key: ORIGIN
    value: https://id.swarm.snaha.net # UPDATE THIS
  - key: APP_DOMAIN
    value: demo.swarm.snaha.net # UPDATE THIS
  - key: ID_DOMAIN
    value: id.swarm.snaha.net # UPDATE THIS
```

### 2. SvelteKit App (if needed)

If you have hardcoded domains in `swarm-ui/src/`, search for:

- `swarm-app.local`
- `swarm-id.local`
- Any hardcoded origins

Replace with environment variables or use `PUBLIC_APP_DOMAIN` and `PUBLIC_ID_DOMAIN`.

### 3. Library Code (if needed)

Check `lib/src/` for any hardcoded domains:

```bash
cd lib && grep -r "swarm-app.local" src/
cd lib && grep -r "swarm-id.local" src/
```

## Quick Search & Replace

To update all domains at once (run from repository root):

```bash
# In .do-app-demo.yaml
sed -i '' 's/demo.swarm.snaha.net/NEW_DEMO_DOMAIN/g' .do-app-demo.yaml
sed -i '' 's/id.swarm.snaha.net/NEW_ID_DOMAIN/g' .do-app-demo.yaml

# In .do-app-id.yaml
sed -i '' 's/demo.swarm.snaha.net/NEW_DEMO_DOMAIN/g' .do-app-id.yaml
sed -i '' 's/id.swarm.snaha.net/NEW_ID_DOMAIN/g' .do-app-id.yaml

# Commit and push to trigger auto-deploy
git add .do-app-demo.yaml .do-app-id.yaml
git commit -m "Update domain configuration"
git push origin main  # Or your deployment branch
```

## Deployment

### Initial Setup (One-time)

1. **Connect GitHub to DigitalOcean:**

   - Go to DigitalOcean Dashboard → Apps
   - Click "Create App" → Choose "GitHub"
   - Authorize DigitalOcean to access your repository
   - Select `snaha/swarm-id-explorations`

2. **Create Demo App:**

   ```bash
   # From repository root
   doctl apps create --spec .do-app-demo.yaml
   ```

3. **Create Identity UI App:**

   ```bash
   # From repository root
   doctl apps create --spec .do-app-id.yaml
   ```

4. **Add Custom Domains:**
   - In DigitalOcean dashboard, go to each app's Settings → Domains
   - Add `demo.swarm.snaha.net` to demo app
   - Add `id.swarm.snaha.net` to identity UI app

### Auto-Deploy

After initial setup, the apps auto-deploy on every push to the `main` branch (or whichever branch you configured).

**To change the deployment branch:**

1. Edit `.do-app-demo.yaml` and `.do-app-id.yaml`
2. Change `branch: main` to your desired branch
3. Update the app: `doctl apps update YOUR_APP_ID --spec .do-app-demo.yaml`

### Manual Updates

If you need to update the app configuration:

```bash
# Get your app IDs first
doctl apps list

# Update demo app
doctl apps update YOUR_DEMO_APP_ID --spec .do-app-demo.yaml

# Update identity UI app
doctl apps update YOUR_ID_APP_ID --spec .do-app-id.yaml
```

## DNS Setup

Point these domains to DigitalOcean in your DNS provider:

```
demo.swarm.snaha.net  →  CNAME to your-demo-app.ondigitalocean.app
id.swarm.snaha.net    →  CNAME to your-id-app.ondigitalocean.app
```

Then add custom domains in the DigitalOcean dashboard for each app.
