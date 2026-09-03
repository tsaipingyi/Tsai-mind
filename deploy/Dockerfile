# Tsai Mind server image: builds core + server, serves API, WebSocket and MCP.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @tsai-mind/core --filter @tsai-mind/server
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @tsai-mind/core build && pnpm --filter @tsai-mind/server build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/.npmrc ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/migrations apps/server/migrations
RUN pnpm install --frozen-lockfile --prod --filter @tsai-mind/core --filter @tsai-mind/server
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
