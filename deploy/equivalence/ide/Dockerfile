FROM ghcr.io/coder/code-server:4.107.1-ubuntu

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk adb git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && java -version \
    && adb version >/dev/null \
    && git --version >/dev/null \
    && mkdir -p /workspace \
    && chown -R coder:coder /workspace

COPY deploy/equivalence/ide/start-ide.sh /usr/local/bin/start-ide.sh
RUN chmod 0755 /usr/local/bin/start-ide.sh

USER coder
WORKDIR /workspace
EXPOSE 8080
CMD ["/usr/local/bin/start-ide.sh"]
