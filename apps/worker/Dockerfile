# syntax=docker/dockerfile:1.7
# SupportPilot ingestion worker (BullMQ): multi-stage build (T16).
#   build:   install the workspace, build worker and the packages it uses, then `pnpm deploy` a
#            self-contained folder with only production dependencies
#   runtime: node:22-alpine, non-root user, just that folder
# Build from the repo root: docker build -f apps/worker/Dockerfile -t supportpilot-worker .

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store     pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@supportpilot/worker... --output-logs=errors-only
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store     pnpm --filter=@supportpilot/worker deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node

CMD ["node", "dist/index.js"]
