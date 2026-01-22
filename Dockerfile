# Development Dockerfile with hot reload support
FROM node:20-slim

# Install mkcert for SSL certificate generation with checksum verification
RUN apt-get update && \
    apt-get install -y wget curl libnss3-tools ca-certificates && \
    MKCERT_VERSION=v1.4.4 && \
    MKCERT_CHECKSUM="6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52" && \
    wget https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-amd64 -O /tmp/mkcert && \
    echo "${MKCERT_CHECKSUM}  /tmp/mkcert" | sha256sum -c - && \
    mv /tmp/mkcert /usr/local/bin/mkcert && \
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

# Expose ports for both servers
EXPOSE 8080 8081 5174

# Default command starts both servers in dev mode
CMD ["./docker-entrypoint.sh"]
