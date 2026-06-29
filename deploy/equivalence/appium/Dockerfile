FROM appium/appium:v3.5.2-p0

RUN test "$(appium --version)" = "3.5.2" \
    && appium driver list --installed | grep -F uiautomator2 \
    && adb version >/dev/null \
    && test -n "$ANDROID_HOME"

EXPOSE 4723
