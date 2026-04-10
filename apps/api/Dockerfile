# ── BUILD STAGE ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests
COPY package.json turbo.json tsconfig.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/db/package.json ./packages/db/
COPY packages/state-machines/package.json ./packages/state-machines/
COPY packages/ai-engine/package.json ./packages/ai-engine/
COPY apps/api/package.json ./apps/api/

RUN npm install --frozen-lockfile

# Copy source
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

# Build
RUN npm run build --workspace=@interview/api

# ── RUNTIME STAGE ─────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only copy production deps
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/

EXPOSE 4000 4001

CMD ["node", "apps/api/dist/index.js"]
