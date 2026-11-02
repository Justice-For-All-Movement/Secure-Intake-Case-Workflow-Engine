FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json.gz.b64 ./
COPY scripts/restore-lockfile.mjs scripts/restore-lockfile.mjs
RUN node scripts/restore-lockfile.mjs && npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder --chown=nextjs:nodejs /app ./
RUN mkdir -p /app/.data/documents && chown -R nextjs:nodejs /app/.data

USER nextjs
EXPOSE 3000
CMD ["npm", "start"]
