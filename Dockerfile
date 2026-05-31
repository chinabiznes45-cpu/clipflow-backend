# Dockerfile — ClipFlow Backend
# Multi-stage build for a lean production image with FFmpeg included

FROM node:20-alpine AS base

# Install FFmpeg and required system dependencies
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    sqlite \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# ── Dependencies stage ────────────────────────────────────────────────────
FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# Rebuild better-sqlite3 for this platform
RUN npm rebuild better-sqlite3

# ── Production stage ──────────────────────────────────────────────────────
FROM base AS production

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Create required directories
RUN mkdir -p uploads generated thumbnails logs db

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Set production env
ENV NODE_ENV=production
ENV PORT=3001

# Start server
CMD ["node", "server.js"]
