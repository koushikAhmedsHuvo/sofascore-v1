# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache optimization)
COPY package*.json ./
RUN npm ci --frozen-lockfile

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build

# Prune dev dependencies for production image
RUN npm ci --omit=dev --frozen-lockfile


# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:22-alpine AS production

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

WORKDIR /app

# Copy only what we need
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./

USER nestjs

EXPOSE 3010

# Healthcheck for Docker / Compose
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3010/api/v1/health/liveness || exit 1

CMD ["node", "dist/main"]
