FROM node:20-bookworm-slim

ARG GRADLE_VERSION=8.10.2
ARG ANDROID_COMMANDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip
ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_HOME=/opt/gradle \
    GRADLE_USER_HOME=/cache/gradle \
    PATH=/opt/gradle/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH} \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless curl unzip ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
    && rm /tmp/gradle.zip \
    && mkdir -p /opt/android-sdk/cmdline-tools /cache/gradle /work \
    && curl -fsSL "$ANDROID_COMMANDLINE_TOOLS_URL" -o /tmp/android-tools.zip \
    && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
    && mkdir -p /opt/android-sdk/cmdline-tools/latest \
    && cp -a /tmp/android-tools/cmdline-tools/. /opt/android-sdk/cmdline-tools/latest/ \
    && rm -rf /tmp/android-tools /tmp/android-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && gradle --version >/dev/null \
    && sdkmanager --version >/dev/null \
    && test -x /opt/android-sdk/platform-tools/adb \
    && test -d /opt/android-sdk/platforms/android-35 \
    && test -x /opt/android-sdk/build-tools/35.0.0/aapt2

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY workers ./workers

RUN useradd --create-home --uid 10001 worker \
    && chown -R worker:worker /app /cache /work /opt/android-sdk
USER worker

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "workers/gradle-build-worker.js"]
