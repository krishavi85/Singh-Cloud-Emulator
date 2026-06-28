FROM ghcr.io/coder/code-server:latest

USER root
ARG ANDROID_COMMANDLINE_TOOLS_URL
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk adb git unzip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/android-sdk/cmdline-tools /workspace \
    && TOOLS_URL="${ANDROID_COMMANDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip}" \
    && curl -fsSL "$TOOLS_URL" -o /tmp/android-tools.zip \
    && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
    && mkdir -p /opt/android-sdk/cmdline-tools/latest \
    && cp -a /tmp/android-tools/cmdline-tools/. /opt/android-sdk/cmdline-tools/latest/ \
    && rm -rf /tmp/android-tools /tmp/android-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && test -x /opt/android-sdk/platform-tools/adb \
    && test -d /opt/android-sdk/platforms/android-35 \
    && test -x /opt/android-sdk/build-tools/35.0.0/aapt2 \
    && chown -R coder:coder /opt/android-sdk /workspace

COPY deploy/equivalence/ide/start-ide.sh /usr/local/bin/start-ide.sh
RUN chmod 0755 /usr/local/bin/start-ide.sh

USER coder
WORKDIR /workspace
EXPOSE 8080
CMD ["/usr/local/bin/start-ide.sh"]
