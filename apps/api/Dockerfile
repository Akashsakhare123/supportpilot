# syntax=docker/dockerfile:1.7
# SupportPilot NestJS API (REST + Socket.io): multi-stage build (T16).
#   build:   install the workspace, build api and the packages it uses, then `pnpm deploy` a
#            self-contained folder with only production dependencies
#   runtime: node:22-alpine, non-root user, just that folder
# Build from the repo root: docker build -f apps/api/Dockerfile -t supportpilot-api .

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store     pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@supportpilot/api... --output-logs=errors-only
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store     pnpm --filter=@supportpilot/api deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT:-4000}/health" > /dev/null || exit 1
CMD ["node", "dist/main.js"]
