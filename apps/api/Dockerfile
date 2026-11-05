FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci

COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN npm run build --workspace=@cebola/contracts \
    && npm run build --workspace=@cebola/api

FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci --omit=dev \
    --workspace=@cebola/contracts \
    --workspace=@cebola/api

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends calibre poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/api ./apps/api

WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
