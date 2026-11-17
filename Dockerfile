# OpenMax image. Build:  docker build -t openmax .
# Pass --build-arg WITH_BROWSER=false to skip Chromium (the agent's browser tool then reports a fix-it message).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG WITH_BROWSER=true
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data CODE_WORKSPACE=/app/workspace AGENT_SANDBOX=/app/data/agent/files PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY data ./data
RUN if [ "$WITH_BROWSER" = "true" ]; then npx --yes playwright@1.56.1 install --with-deps chromium; fi
EXPOSE 8787
VOLUME ["/app/data", "/app/workspace"]
CMD ["node", "server/dist/index.js"]
