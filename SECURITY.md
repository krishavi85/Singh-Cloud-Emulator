# Production security guide

Singh Cloud Emulator can control Android development devices and install uploaded APK files. Treat the control service, Android workers, uploaded files, credentials, and audit records as security-sensitive infrastructure.

## Controls implemented

- Bcrypt password verification with signed, HttpOnly, SameSite=Strict session cookies
- Secure-cookie enforcement and minimum secret length in production
- Per-account Android device assignments
- Authenticated WebSocket upgrades with events delivered only to the owning user
- Application and Nginx request limits
- Strict request-origin checks for state-changing requests
- HTTPS-only production mode, HSTS, TLS 1.2/1.3, and no direct API port exposure
- ClamAV scanning before APK installation, with fail-closed production behavior
- SHA-256 recording for every scanned APK
- User-scoped temporary upload directories and immediate post-processing deletion
- Periodic upload and audit-log retention cleanup
- Append-only JSONL audit records linked with HMAC hashes
- Non-root application container, read-only root filesystem, dropped capabilities, resource limits, and internal networks
- A one-user/one-worker Android sandbox template

## Required production preparation

### 1. Generate secrets

Generate two different random values of at least 32 characters:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Use one for `JWT_SECRET` and the other for `AUDIT_HMAC_KEY`. Never commit `.env.production`.

### 2. Generate password hashes

```bash
npm install
npm run hash-password -- "use-a-long-unique-password"
```

Copy `deploy/secrets/users.example.json` to `deploy/secrets/users.json` and replace each placeholder hash. Give every account a unique ID and an explicit list of Android serials.

Do not assign the same Android worker to unrelated users.

### 3. Configure HTTPS

Copy `.env.production.example` to `.env.production` and set `PUBLIC_ORIGIN` to the exact public HTTPS origin.

Place the certificate files here:

```text
deploy/certs/fullchain.pem
deploy/certs/privkey.pem
```

The production Compose stack exposes Nginx on ports 80 and 443. The Node API is only available on an internal Docker network.

### 4. Deploy ClamAV

The Compose stack starts a ClamAV daemon on the internal network. `CLAMAV_REQUIRED=true` is mandatory for public use. When the scanner is unhealthy or unavailable, APK uploads are rejected.

Antivirus scanning reduces risk but does not prove that an APK is safe. Android workers must still be disposable and isolated.

### 5. Isolate Android workers

For untrusted APKs, a dedicated virtual machine per active user session is preferred over sharing one host emulator. Each worker should use:

- A disposable VM or container instance
- A read-only base image and disposable data disk
- A separate ADB endpoint
- No inbound public ports
- An internal network reachable only by the control service
- Restricted outbound network access
- CPU, memory, process, and session-time limits
- No host credentials, cloud metadata access, or shared secrets
- Automatic destruction after the session expires

`deploy/worker-sandbox.yml` is a baseline container template. Android images vary, so review the required writable paths and capabilities for the selected image. Do not grant `privileged: true` unless an independent security review concludes it is unavoidable. For hostile APK execution, use a KVM-backed VM boundary.

### 6. Protect audit records

Audit records are stored as JSON Lines files under `AUDIT_LOG_DIR`. Each record contains the previous record hash and an HMAC of the current record. Store the audit HMAC key outside the container image.

Forward audit logs to append-only external storage or a SIEM. Local HMAC chaining helps detect edits but cannot prevent a compromised host from deleting the entire log directory.

## Retention

- Uploaded APK files are removed immediately after installation or rejection.
- Abandoned upload files are removed after `UPLOAD_RETENTION_MINUTES`.
- Audit files are removed after `AUDIT_RETENTION_DAYS`.
- Run retention settings through legal, privacy, and incident-response review before production.

## Operational requirements

- Keep Node.js, npm dependencies, Android tooling, Nginx, ClamAV, and worker images patched.
- Pin reviewed container image digests for controlled deployments.
- Rotate JWT and audit keys through a documented procedure.
- Back up only required configuration and audit data; do not back up transient APK uploads.
- Alert on repeated failed logins, denied device access, scanner failures, rejected APKs, and unusual installation volume.
- Test restoration, certificate renewal, and worker destruction regularly.

## Known boundary

The repository enforces logical user-to-device separation. Strong isolation still depends on deploying one disposable Android worker VM or container per user/session and ensuring that the ADB endpoint for that worker cannot be reached by other tenants.
