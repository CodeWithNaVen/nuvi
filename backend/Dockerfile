# NUVI backend — Fly.io
# Persistent Node + WebSocket server (Express + ws + Gemini Live)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi
COPY server.ts server_memory.ts server_paths.ts ./
COPY src ./src
RUN npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Fly/Render sets PORT automatically; server.ts:1589 reads process.env.PORT
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY package.json package-lock.json* ./
# Install only prod deps (ws, express, @google/genai, dotenv)
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi && npm cache clean --force
# Optional persistent data dir — mount a Fly volume at /data and set NUVI_DATA_DIR=/data
RUN mkdir -p /data /tmp/nuvi-data
EXPOSE 8080
CMD ["node", "dist/server.cjs"]
