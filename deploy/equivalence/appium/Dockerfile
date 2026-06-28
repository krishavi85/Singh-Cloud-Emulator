FROM node:24-bookworm-slim

ARG APPIUM_VERSION=3.5.2
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb openjdk-17-jre-headless ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "appium@${APPIUM_VERSION}" \
    && appium driver install uiautomator2 \
    && appium --version | grep -F "${APPIUM_VERSION}" \
    && appium driver list --installed | grep -F uiautomator2 \
    && adb version >/dev/null \
    && npm cache clean --force

RUN useradd --create-home --uid 10001 appium \
    && mkdir -p /home/appium/.appium \
    && cp -a /root/.appium/. /home/appium/.appium/ \
    && chown -R appium:appium /home/appium

USER appium
WORKDIR /home/appium
EXPOSE 4723
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["appium", "--address", "0.0.0.0", "--port", "4723", "--base-path", "/"]
