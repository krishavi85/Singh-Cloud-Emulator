FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv adb ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/mitmproxy \
    && /opt/mitmproxy/bin/pip install --no-cache-dir --upgrade pip mitmproxy

ENV PATH=/opt/mitmproxy/bin:${PATH}
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY workers ./workers

RUN useradd --create-home --uid 10001 worker \
    && mkdir -p /captures \
    && chown -R worker:worker /app /captures
USER worker

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "workers/traffic-observer-worker.js"]
