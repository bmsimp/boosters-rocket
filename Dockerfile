# syntax=docker/dockerfile:1
FROM node:26-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12 && pnpm --version
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Placeholders only so the env schema parses during `next build`. No real secret is ever present here.
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    APP_URL=https://build.invalid \
    BETTER_AUTH_SECRET=build-placeholder-not-a-secret-0000000000
RUN pnpm build

FROM base AS tools
# Exactly the drizzle-orm and postgres versions the app resolved, nothing else.
COPY --from=deps /app/node_modules/drizzle-orm/package.json /tmp/drizzle-orm.json
COPY --from=deps /app/node_modules/postgres/package.json /tmp/postgres.json
WORKDIR /tools
RUN printf '{"name":"booster-rocket-tools","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
      "drizzle-orm@$(node -p "require('/tmp/drizzle-orm.json').version")" \
      "postgres@$(node -p "require('/tmp/postgres.json').version")"
COPY drizzle ./drizzle
COPY scripts/migrate.mjs scripts/seed-poc-guardian.mjs ./scripts/

FROM node:26-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 TZ=America/Chicago
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=tools --chown=node:node /tools ./tools
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
