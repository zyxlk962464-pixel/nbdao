FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar gzip \
    && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@11.22.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/keeper/package.json apps/keeper/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .

# Only public wallet settings enter the build. Never declare a private-key ARG.
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
RUN node scripts/install-tools.mjs && pnpm build

# The HTTP process cannot read the signer's environment or private data directory.
RUN groupadd --gid 1001 nbdao-web && useradd --uid 1001 --gid 1001 --no-log-init --create-home --shell /usr/sbin/nologin nbdao-web \
    && groupadd --gid 1002 nbdao-keeper && useradd --uid 1002 --gid 1002 --no-log-init --create-home --shell /usr/sbin/nologin nbdao-keeper \
    && mkdir -p /app/apps/web/.next/cache \
    && chown -R 1001:1001 /app/apps/web/.next/cache

ENV NODE_ENV=production SELLER_MODE=read-only KEEPER_HOST=127.0.0.1 \
    KEEPER_PORT=8787 KEEPER_DATABASE=/data/keeper.sqlite RUNTIME_ISOLATION=1
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
