FROM node:24-bookworm-slim

ARG APPIUM_VERSION=3.5.2
ARG ANDROID_COMMANDLINE_TOOLS_URL
ENV DEBIAN_FRONTEND=noninteractive \
    APPIUM_HOME=/opt/appium-home \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless curl unzip ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/android-sdk/cmdline-tools /opt/appium-home \
    && TOOLS_URL="${ANDROID_COMMANDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip}" \
    && curl -fsSL "$TOOLS_URL" -o /tmp/android-tools.zip \
    && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
    && mkdir -p /opt/android-sdk/cmdline-tools/latest \
    && cp -a /tmp/android-tools/cmdline-tools/. /opt/android-sdk/cmdline-tools/latest/ \
    && rm -rf /tmp/android-tools /tmp/android-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && npm install --global "appium@${APPIUM_VERSION}" \
    && appium driver install uiautomator2 \
    && test "$(appium --version)" = "${APPIUM_VERSION}" \
    && appium driver list --installed | grep -F uiautomator2 \
    && test -x /opt/android-sdk/platform-tools/adb \
    && test -x /opt/android-sdk/build-tools/35.0.0/aapt2 \
    && npm cache clean --force

RUN useradd --create-home --uid 10001 appium \
    && chown -R appium:appium /opt/appium-home /opt/android-sdk /home/appium

USER appium
WORKDIR /home/appium
EXPOSE 4723
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["appium", "--address", "0.0.0.0", "--port", "4723", "--base-path", "/"]
