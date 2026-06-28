# Singh Cloud Emulator

Singh Cloud Emulator is a self-hosted Android cloud platform for secure browser-based device interaction, testing, diagnostics, profiling and development workspaces.

## Included capabilities

- Browser Android screen display and authenticated control
- Tap, swipe, text, key, rotation, screenshot and package-launch controls
- APK upload, SHA-256 identification, ClamAV scanning and installation
- User authentication, assigned-device authorization and scoped WebSockets
- Cloud device profiles, session leases, worker lifecycle APIs and usage records
- UI automation recording and replay
- Logcat, package, memory and network diagnostics
- Mock GPS, locale, dark mode, font size, battery, connectivity and biometrics
- Permission, app-operation and deep-link controls
- Sandboxed Android Kotlin/Gradle workspaces
- APK/AAB build queue and artifact metadata
- Share links, embed presentation, plans and administration foundations
- Appium UiAutomator2 integration
- mitmproxy network-capture control
- Perfetto traces, Android heap dumps and UI hierarchy inspection
- Cuttlefish WebRTC, cloud IDE, proxy, profiler and debugger service registry
- Production TLS, rate limiting, audit logging, retention and container isolation

## Interfaces

After starting the application:

```text
http://127.0.0.1:8080/                  Android emulator dashboard
http://127.0.0.1:8080/workbench.html    Cloud platform workbench
http://127.0.0.1:8080/equivalence.html  Runtime integration console
```

## Requirements

### Local development

- Node.js 20 or newer
- Android SDK Platform Tools (`adb`)
- An Android emulator or authorized development device
- Hardware virtualization for local emulators

### Public deployment

- Docker Engine with Compose
- Valid TLS certificates
- ClamAV
- One isolated Android worker per user/session
- KVM-backed workers for untrusted APK execution
- Separate secrets for sessions, auditing, databases and TURN

## Local installation

```bash
git clone https://github.com/krishavi85/Singh-Cloud-Emulator.git
cd Singh-Cloud-Emulator
npm install
cp .env.example .env
npm start
```

PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

The development template contains a local-only account:

```text
Email: local@example.com
Password: change-this-local-password
```

Change the password hash and all development secrets before using the project outside a local machine. The example account is assigned to `emulator-5554`; change the serial in `.env` when necessary.

For Windows, configure the full ADB path when it is not in `PATH`:

```env
ADB_PATH=C:/Users/YOUR_NAME/AppData/Local/Android/Sdk/platform-tools/adb.exe
```

## Secure control-plane deployment

Prepare private configuration:

```bash
cp .env.production.example .env.production
cp deploy/secrets/users.example.json deploy/secrets/users.json
```

Generate different secrets for JWT sessions and audit HMAC chaining:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Generate bcrypt password hashes:

```bash
npm install
npm run hash-password -- "a-long-unique-password"
```

Install certificates at:

```text
deploy/certs/fullchain.pem
deploy/certs/privkey.pem
```

Start the protected control plane:

```bash
docker compose -f compose.production.yml up -d --build
```

Only the TLS gateway should be public. The API, ClamAV, databases, object storage and ADB endpoints must remain private.

## Appetize and Android Studio equivalence stack

The project uses maintained components instead of recreating every subsystem:

- AOSP Cuttlefish native WebRTC for browser streaming
- Google Android Emulator container scripts as a fallback
- code-server with Java, ADB and Android SDK tools for the browser IDE
- Appium UiAutomator2 for native and hybrid test automation
- mitmproxy for traffic capture and HAR output
- Perfetto and Simpleperf for profiling
- Debug Adapter Protocol for debugger integration
- PostgreSQL, Redis and S3-compatible object storage for scale
- coturn for WebRTC NAT traversal

Prepare the sidecar configuration:

```bash
cp .env.equivalence.example .env.equivalence
```

Start the sidecar services:

```bash
docker compose --env-file .env.equivalence -f compose.equivalence.yml up -d --build
```

The Android command-line tools URL is intentionally supplied at build time because Google changes package revisions. The IDE remains usable without it, but Android compilation requires the command-line tools and SDK packages.

Configure the service URLs from `.env.equivalence.example` in the control-plane environment. The integration console reports the health of Cuttlefish, code-server, Appium, mitmproxy, Perfetto and the debugger adapter.

See [docs/EQUIVALENCE_STACK.md](docs/EQUIVALENCE_STACK.md) for the selected methods, deployment sequence and exact boundaries.

## Android workers

Review `deploy/worker-sandbox.yml`, set `ANDROID_WORKER_IMAGE` to a reviewed image and start one disposable worker for one user/session:

```bash
docker compose -f deploy/worker-sandbox.yml up -d
```

Cuttlefish is the preferred remote-runtime method because it already provides browser WebRTC control. Worker lifecycle must still be connected to the existing session queue, attachment, heartbeat and completion APIs.

Never expose ADB port 5037 publicly. For hostile or unknown APKs, use a disposable KVM-backed virtual machine rather than relying only on a shared container.

## Security model

The server refuses to start without configured bcrypt users and a sufficiently long JWT secret. Production requires HTTPS, secure cookies, assigned devices and available APK scanning. State-changing browser requests must originate from `PUBLIC_ORIGIN`.

Network interception is intended only for authorized test sessions. HTTPS inspection requires a session-specific CA, and certificate-pinned applications can reject interception by design.

See [SECURITY.md](SECURITY.md) for deployment requirements, audit handling, retention and worker-isolation guidance.

## Validation

```bash
npm run check
npm audit --omit=dev --audit-level=high
docker compose --env-file .env.equivalence -f compose.equivalence.yml config
```

GitHub Actions runs JavaScript syntax checks, dependency auditing and Compose validation.

## Remaining infrastructure work

The repository now contains the control plane and adapters, but a production service still requires operators to deploy and connect:

- Autoscaled Cuttlefish or emulator workers
- An Android SDK/Gradle build-worker fleet
- A Java/Kotlin DAP service and LLDB for native debugging
- Simpleperf and advanced profiler presentation
- PostgreSQL repositories and Redis-backed queues
- S3-compatible artifact persistence
- Per-session mitmproxy instances
- Apple-hosted iOS simulator workers

These are deployment services rather than features that can run inside one Node.js process.

## License

MIT
