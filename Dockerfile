# Development Dockerfile with hot reload support
FROM node:20-slim

# Install mkcert for SSL certificate generation
RUN apt-get update && \
    apt-get install -y wget curl libnss3-tools && \
    wget https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-amd64 -O /usr/local/bin/mkcert && \
    chmod +x /usr/local/bin/mkcert && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

WORKDIR /app

# Copy package files first for better caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/package.json ./lib/
COPY swarm-ui/package.json ./swarm-ui/
COPY demo/package.json ./demo/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Generate SSL certificates (will be run in entrypoint)
# The certificates will be generated when the container starts

# Expose ports for both servers
EXPOSE 8080 8081 5174

# Default command starts both servers in dev mode
CMD ["./docker-entrypoint.sh"]
