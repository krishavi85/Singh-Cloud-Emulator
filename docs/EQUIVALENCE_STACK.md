# Equivalence stack

This document defines the practical architecture for approaching Appetize-style cloud testing and Android Studio-style development without reimplementing every low-level component.

## Core decision

Singh Cloud Emulator remains the authenticated control plane. Specialized, maintained components run as isolated services around it:

| Capability | Selected method |
|---|---|
| Low-latency Android streaming | AOSP Cuttlefish native WebRTC |
| Android emulator fallback | Google Android Emulator container scripts |
| Browser IDE | code-server with JDK, ADB, Android SDK and Gradle |
| Native/hybrid app automation | Appium with the official UiAutomator2 driver |
| Network inspection and HAR | mitmproxy per session |
| System and memory tracing | Perfetto |
| CPU profiling | Simpleperf |
| Java/Kotlin debugger UI | Debug Adapter Protocol plus a Java debug adapter |
| Build orchestration | Gradle Tooling API or isolated Gradle workers |
| Scale and queues | PostgreSQL, Redis and disposable workers |
| Artifact storage | S3-compatible object storage such as MinIO |
| NAT traversal | coturn |

## Why Cuttlefish is the preferred streaming runtime

AOSP documents Cuttlefish WebRTC as a browser-based remote-control system with efficient encoding, in-browser ADB and an extensible protocol that can carry camera, microphone and sensor data. This removes the need to invent a proprietary H.264 transport.

Official reference:

- https://source.android.com/docs/devices/cuttlefish/webrtc
- https://source.android.com/docs/devices/cuttlefish/get-started

Each public session should receive one disposable Cuttlefish instance or VM. The scheduler stores the worker ID and renders the configured `CUTTLEFISH_SESSION_URL_TEMPLATE` for the authenticated user.

For Google Android Emulator images, the official container scripts remain a fallback:

- https://github.com/google/android-emulator-container-scripts
- https://source.android.com/docs/automotive/start/avd/cloud_emulator

## Browser IDE

The equivalence stack adds a code-server image with Java 17, ADB, Git and optional Android command-line tools. It should be deployed per workspace or per user, behind the Singh authentication gateway.

Official reference:

- https://coder.com/docs/code-server

Recommended extensions or adapters:

- Java language support
- Gradle project support
- Kotlin language support where compatible
- Java Debug Adapter
- Git integration

The Android SDK command-line tools URL must be supplied at build time because Google periodically changes the package revision. Do not bake developer signing keys into the image.

## Android builds

The current control plane already queues APK and AAB builds. A production build worker should use either the Gradle wrapper directly or the Gradle Tooling API, mount one authorized workspace, use a disposable cache, stream logs and upload artifacts to object storage.

Official reference:

- https://docs.gradle.org/current/userguide/tooling_api.html

The build container must have CPU, memory, process, network and execution-time limits. Release signing should be a separate service with narrowly scoped access to encrypted signing material.

## Automation

Appium UiAutomator2 provides standards-based native, hybrid and web-view automation. The new Appium adapter creates sessions only for Android serials already assigned to the authenticated Singh account.

Official references:

- https://appium.io/docs/en/latest/quickstart/uiauto2-driver/
- https://github.com/appium/appium-uiautomator2-driver
- https://developer.android.com/training/testing/other-components/ui-automator

The existing lightweight recorder remains useful for quick replay. Appium should be used for selectors, accessibility-tree inspection, test suites and CI execution.

## Network inspection

The network-capture adapter configures the assigned Android device to use a per-session mitmproxy endpoint. mitmproxy can stream flows to disk and generate HAR output. HTTPS inspection requires the test device or app to trust the session CA; certificate-pinned apps may intentionally reject interception.

Official reference:

- https://docs.mitmproxy.org/stable/concepts/options/

Never use one proxy instance for unrelated tenants. Run one capture service per session or enforce independent authenticated proxy identities and isolated storage.

## Profiling and inspection

The control plane can now collect:

- Perfetto system traces
- Android heap dumps
- UI Automator hierarchy XML

Perfetto collects Android performance data through ADB. Simpleperf can provide Java and native CPU profiles when available in the worker toolchain.

Official references:

- https://developer.android.com/tools/perfetto
- https://perfetto.dev/docs/
- https://developer.android.com/ndk/guides/simpleperf

Perfetto traces can be opened with the official Perfetto UI. Heap dumps and traces are stored per user and served only through authenticated routes.

## Debugging

Use Debug Adapter Protocol as the browser-to-debugger contract. A Java/Kotlin adapter can translate IDE operations such as breakpoints, stepping, variables and evaluation to JDWP-based Android debugging.

Official references:

- https://microsoft.github.io/debug-adapter-protocol/
- https://github.com/microsoft/debug-adapter-protocol
- https://github.com/microsoft/vscode-java-debug

Native C/C++ debugging additionally requires LLDB and an Android NDK-aware adapter in the worker.

## Data and scale

The current JSON store is suitable for a single control-plane process. Appetize-scale operation requires:

- PostgreSQL for organizations, users, apps, sessions, workers, builds, shares and audit indexes
- Redis for queues, distributed locks, session presence and rate-limit coordination
- S3-compatible object storage for APKs, AABs, traces, HAR files, screenshots and logs
- Multiple stateless control-plane replicas
- An autoscaling worker scheduler

The equivalence Compose file starts PostgreSQL, Redis and MinIO as the migration target, but the existing JSON store remains active until database repositories and migrations are connected.

## iOS boundary

Android equivalence can be built on Linux/KVM. iOS simulator service requires Apple hardware, macOS and Xcode-compatible infrastructure. It must be implemented as a separate Apple-hosted worker pool. No Linux container can provide a legitimate complete iOS Simulator replacement.

## Deployment sequence

1. Deploy the existing secure control plane.
2. Deploy `compose.equivalence.yml` and configure all secrets.
3. Build the IDE image with the current official Android command-line tools URL.
4. Deploy one Cuttlefish VM and configure the session URL template.
5. Connect Appium and mitmproxy to the same private worker network.
6. Verify Perfetto, heap and hierarchy artifacts on a test account.
7. Replace the JSON store with PostgreSQL repositories and Redis queues.
8. Add autoscaling Cuttlefish and build workers.
9. Add Java DAP, LLDB, Simpleperf and layout-inspection front ends.
10. Add Apple-hosted iOS workers only after licensing and infrastructure review.

## Equivalence meaning

This stack can reproduce the major functional categories of Appetize and most remote Android development workflows. It will not be the same proprietary implementation, capacity, device-image library, support organization or service-level agreement. Android Studio itself also contains proprietary IntelliJ-platform integration and internal Android tooling that cannot simply be copied; the browser IDE uses compatible open protocols and command-line tools instead.
