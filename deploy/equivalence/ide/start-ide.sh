#!/bin/sh
set -eu

extensions="${CODE_SERVER_EXTENSIONS:-redhat.java,vscjava.vscode-java-debug,vscjava.vscode-gradle}"
old_ifs="$IFS"
IFS=','
for extension in $extensions; do
  extension="$(printf '%s' "$extension" | tr -d ' ')"
  [ -z "$extension" ] && continue
  code-server --install-extension "$extension" >/tmp/extension-install.log 2>&1 || {
    printf 'Extension installation skipped for %s\n' "$extension" >&2
    cat /tmp/extension-install.log >&2 || true
  }
done
IFS="$old_ifs"

exec code-server --bind-addr 0.0.0.0:8080 --auth password /workspace
