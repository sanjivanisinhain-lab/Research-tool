# syntax=docker/dockerfile:1
# Research Hub: one container serves the web app and the API. Data lives in the /data volume.

# 1) build the web app
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# 2) the server's own small dependency list (not the whole frontend toolchain): less to patch, less to attack
FROM oven/bun:1.4 AS deps
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

# 3) the image that runs
FROM oven/bun:1.4
# ffmpeg turns recordings into audio and small picture clips; tar makes backups
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tar ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=8787 STATIC_DIR=/app/dist/client
COPY server ./server
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY src/types ./src/types
COPY src/config ./src/config
COPY --from=build /app/dist/client ./dist/client
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
