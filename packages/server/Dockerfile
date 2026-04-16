# Stage 1: build web
FROM node:22-alpine AS web-build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/web/package.json ./packages/web/
RUN npm ci --workspace @opencode-remote/web
COPY packages/web ./packages/web
RUN npm run build:web

# Stage 2: build server
FROM node:22-alpine AS server-build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
RUN apk add --no-cache python3 make g++ && npm ci --workspace @opencode-remote/server
COPY packages/server ./packages/server
RUN npm run build:server

# Stage 3: runtime
FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
RUN npm ci --workspace @opencode-remote/server --omit=dev
COPY --from=server-build /workspace/packages/server/dist ./packages/server/dist
COPY --from=web-build /workspace/packages/web/dist ./packages/web/dist
WORKDIR /workspace/packages/server
VOLUME ["/data"]
ENV DATABASE_PATH=/data/opencode-remote.db
EXPOSE 9223
CMD ["node", "dist/index.js"]
