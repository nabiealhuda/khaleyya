# syntax=docker/dockerfile:1

# ---- deps: install dependencies (cached separately from source changes) ----
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# --ignore-scripts skips package.json's "postinstall": "prisma generate" here.
# That step needs its own network fetch for Prisma's engine binary, and
# running it a second time (redundantly) inside this stage — on top of the
# explicit `prisma generate` already run in the builder stage below — only
# doubles the chance of a slow/hung network fetch derailing the build with no
# clear indication of which of the two identical steps actually stalled.
RUN npm install --legacy-peer-deps --ignore-scripts

# ---- builder: generate Prisma client + compile Next.js ----
FROM node:20-slim AS builder
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# A dummy DATABASE_URL is enough for `next build` — it only needs the Prisma
# client generated (schema-aware types), it never opens a real connection.
ENV DATABASE_URL="postgresql://user:password@localhost:5432/db"
ENV SESSION_SECRET="build-time-placeholder-secret-not-used-at-runtime-000000"
# Disables Prisma's telemetry/update-check ping — an unrelated network call
# that has, in some CI/container environments, been slow enough to make a
# generate step that should take seconds look stuck.
ENV CHECKPOINT_DISABLE=1
RUN npx prisma generate
RUN npm run build

# ---- runner: minimal production image ----
FROM node:20-slim AS runner
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Next.js standalone output: a self-contained server.js plus only the
# node_modules it actually needs — much smaller than shipping the full tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# The seed script (run via tsx, transpiled on the fly, not prebuilt) imports
# from src/lib/integrations — that source needs to exist in the final image
# for that one relative import to resolve at container start.
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/integrations ./src/lib/integrations
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
# Next's standalone output only traces node_modules for what the Next.js
# server itself imports — it does NOT know about prisma/tsx, which the CMD
# below invokes directly as separate CLI processes outside Next's module
# graph. Cherry-picking specific subfolders (prisma, @prisma, tsx, bcryptjs)
# previously broke at runtime with "ENOENT ... prisma_schema_build_bg.wasm"
# because Prisma's CLI needs extra helper files (a wasm binary, engine
# files) that live at paths this project doesn't control and that shift
# between Prisma versions. Copying the full node_modules here instead is a
# few hundred MB larger but eliminates this whole class of "missing sibling
# file" bug for good — Docker COPY merges into the existing ./node_modules
# from the standalone copy above rather than replacing it.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# On boot: sync the schema to Postgres (prisma db push — no migration
# history file is checked into this repo, so this is the reliable path for
# a first deploy; see README for the tradeoff and how to move to versioned
# migrations later), seed if empty (idempotent — every insert in seed.ts is
# upsert/guarded), then start the server. A redeploy on top of real merchant
# data changes nothing (push is a no-op once the schema matches, and every
# seed guard short-circuits once real rows exist).
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && node_modules/.bin/tsx prisma/seed.ts && node server.js"]
