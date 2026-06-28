FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/* \
    && adb version >/dev/null \
    && git --version >/dev/null

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/uploads /app/data/audit /app/data/artifacts /app/data/profiles /app/data/workspaces \
    && chown -R node:node /app/uploads /app/data

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
