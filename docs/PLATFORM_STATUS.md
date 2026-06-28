# Platform expansion status

Version 0.3 adds a unified control plane and workbench around the secure Android emulator MVP.

## Implemented in this repository

- Android screen display through the existing PNG stream
- Authenticated device control and APK installation
- Device profile catalog for phone, tablet, TV, and Wear OS targets
- Session creation, expiration, stopping, usage events, and worker attachment state
- Per-user session and resource ownership
- Share-token creation, revocation, presentation pages, and same-origin embed routes
- Authenticated WebSocket session rooms
- WebRTC offer, answer, and ICE-candidate relay
- Worker, terminal, build, and session event relay
- UI action recording data model and replay execution
- Logcat retrieval and clearing
- Package, memory, activity, Wi-Fi, connectivity, and network-stat diagnostics
- Mock GPS location, locale, dark mode, font scale, battery, connectivity, biometric, permission, app-op, and deep-link controls
- Sandboxed Android project workspaces
- Starter Kotlin/Gradle Android application template
- Workspace file listing, reading, writing, and deletion
- Build queue, worker claim, completion, APK/AAB artifact metadata, and build logs
- Application registry
- Plan, usage, and administrator overview APIs
- Unified browser workbench
- Session-worker queue, attachment, heartbeat, and completion APIs

## Requires an external adapter or worker

The control plane exposes the contracts, but these components require separate runtime infrastructure:

- H.264 capture and WebRTC media publication
- Android audio capture and Opus publication
- Disposable KVM virtual-machine provisioning
- A reviewed Android worker image
- Gradle/Android SDK build-worker execution
- Object storage for APK, AAB, build-log, and recording artifacts
- HTTPS certificate issuance and renewal
- Network proxy or VPN capture for HAR generation
- Android Studio debugger adapter
- Layout Inspector bridge
- CPU, memory, GPU, and energy profiler agents
- Git clone, credential, and pull-request integration
- PostgreSQL and Redis migration for horizontal scaling
- Payment-provider and subscription integration
- iOS simulator workers, which require Apple hardware and licensing

## Important distinction

A route or data model marked as implemented means the server and browser can create, store, authorize, and manage that feature. It does not mean a required external media, build, emulator, debugger, or billing service is bundled inside the Node.js control-plane container.

## Recommended deployment stages

1. Run the secure local emulator and workbench.
2. Add one disposable Android worker and verify session leasing.
3. Add a build worker with a mounted workspace and artifact volume.
4. Add H.264/WebRTC media publication.
5. Replace the JSON platform store with PostgreSQL and add Redis queues.
6. Add network capture, debugging, profiling, billing, and organization administration.
7. Add iOS workers only on properly licensed Apple infrastructure.
