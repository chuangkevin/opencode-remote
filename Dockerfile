FROM node:22-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/package.json

RUN npm ci

COPY packages/server/ packages/server/

RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS production

WORKDIR /app

# Install OpenCode CLI globally
RUN npm install -g opencode

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist

ENV NODE_ENV=production
ENV PORT=9223
ENV OPENCODE_PORT=4096

EXPOSE 9223

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9223/global/health',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(JSON.parse(d).healthy?0:1))}).on('error',()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
