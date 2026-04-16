# Stage 1: build
FROM node:22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/runner/package.json ./packages/runner/
RUN npm ci --workspace @opencode-remote/runner
COPY packages/runner ./packages/runner
RUN npm run build:runner

# Stage 2: runtime (no production deps — runner has only devDeps)
FROM node:22-alpine
WORKDIR /app
COPY --from=build /workspace/packages/runner/dist ./dist
CMD ["node", "dist/index.js"]
