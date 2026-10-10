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

ENV NODE_ENV=production SELLER_MODE=read-only KEEPER_HOST=127.0.0.1 \
    KEEPER_PORT=8787 KEEPER_DATABASE=/data/keeper.sqlite
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
