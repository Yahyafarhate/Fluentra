# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# full node_modules on purpose: `tsx` runs migrations and the background worker from the same image
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/public* ./public
USER node
EXPOSE 3000
# web:    node_modules/.bin/next start
# worker: npm run worker           (or call POST /api/cron/tick every minute instead)
# deploy: npm run db:migrate       (as the owner role, before starting the new version)
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
