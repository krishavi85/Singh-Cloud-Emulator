# Singh Cloud Emulator

Singh Cloud Emulator is a self-hosted browser dashboard for securely viewing and interacting with assigned Android emulators or ADB-connected development devices.

## Features

- Browser screen streaming and Android interaction
- Mouse, touch, swipe, text, Home, Back, Recents, Power, and rotation controls
- APK upload, SHA-256 identification, ClamAV scanning, installation, and immediate deletion
- Bcrypt-based user authentication with signed HttpOnly cookies
- Per-user Android device assignments
- Authenticated, user-scoped WebSocket events
- Application and Nginx rate limiting
- HTTPS-only production mode with HSTS
- Tamper-evident JSONL audit logging
- Upload and audit retention sweeps
- Non-root, read-only container deployment
- One-user/one-worker Android sandbox template

## Requirements

### Local development

- Node.js 20 or newer
- Android SDK Platform Tools (`adb`)
- An Android emulator started from Android Studio Device Manager or an authorized development device
- Hardware virtualization enabled

### Public deployment

- Docker Engine with Compose
- A valid TLS certificate
- ClamAV or the included ClamAV service
- One isolated Android worker per user/session
- KVM-backed virtual machines are recommended for untrusted APK execution

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

Open `http://127.0.0.1:8080`.

The development template contains a local-only account:

```text
Email: local@example.com
Password: change-this-local-password
```

Change the password hash and JWT/audit secrets before using the project beyond local development. The example account is assigned to `emulator-5554`; update the serial in `.env` when your emulator uses a different serial.

For Windows, set the full ADB path when it is not already available in `PATH`:

```env
ADB_PATH=C:/Users/YOUR_NAME/AppData/Local/Android/Sdk/platform-tools/adb.exe
```

## Public deployment

### 1. Prepare configuration

```bash
cp .env.production.example .env.production
cp deploy/secrets/users.example.json deploy/secrets/users.json
```

Generate two different secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Set them as `JWT_SECRET` and `AUDIT_HMAC_KEY` in `.env.production`.

### 2. Hash user passwords

```bash
npm install
npm run hash-password -- "a-long-unique-password"
```

Place only bcrypt hashes in `deploy/secrets/users.json`. Assign each account its own Android serial or serials.

### 3. Install TLS certificates

```text
deploy/certs/fullchain.pem
deploy/certs/privkey.pem
```

Set `PUBLIC_ORIGIN` to the exact public HTTPS origin.

### 4. Start the protected control plane

```bash
docker compose -f compose.production.yml up -d --build
```

Only Nginx publishes ports. The API and ClamAV services remain on internal Docker networks.

### 5. Start an isolated Android worker

Review `deploy/worker-sandbox.yml`, set `ANDROID_WORKER_IMAGE` to a trusted image, and start one disposable worker for one user/session:

```bash
docker compose -f deploy/worker-sandbox.yml up -d
```

For hostile or unknown APKs, use an isolated KVM virtual machine instead of relying solely on a container. Never expose ADB port 5037 publicly.

## Security model

The server refuses to start without a sufficiently long JWT secret and configured bcrypt users. In production, secure cookies, HTTPS, assigned devices, and ClamAV availability are mandatory. State-changing browser requests must originate from `PUBLIC_ORIGIN`.

The browser cannot start or stop emulator processes in public mode. Worker lifecycle must be handled by an external scheduler or VM/container orchestrator.

See [SECURITY.md](SECURITY.md) for deployment requirements, threat boundaries, audit handling, retention, and worker-isolation guidance.

## Validation

```bash
npm run check
npm audit --omit=dev --audit-level=high
```

The repository also runs these checks through GitHub Actions.

## Current limitations

- PNG frame streaming is higher latency than WebRTC/H.264.
- Device assignments are configuration-based; a production platform should add a scheduler and durable session database.
- Strong tenant separation depends on correctly deployed disposable Android workers.
- Certificates and worker images are operator-supplied and must be patched and reviewed.

## License

MIT
