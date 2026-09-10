FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY bin ./bin
COPY dashboard ./dashboard
COPY host ./host
COPY monitor/src ./monitor/src
COPY src ./src
COPY test ./test
COPY vitest.node.config.js ./

# These connection-heavy tests can exceed their 5 second per-test timeout when
# many files run concurrently under emulation. Run the complete suite serially
# so a cross-architecture production build is deterministic.
RUN npm test -- --maxWorkers=1 --fileParallelism=false \
    && npm prune --omit=dev \
    && npm cache clean --force

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/dashboard ./dashboard
COPY --from=build --chown=node:node /app/host ./host
COPY --from=build --chown=node:node /app/monitor/src ./monitor/src
COPY --from=build --chown=node:node /app/src ./src

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/metrics').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "bin/relay.js"]
