# Self-hosted Lago billing

Singh Cloud Emulator integrates with Lago through `LAGO_API_URL`, `LAGO_API_KEY` and signed webhooks. Deploy Lago from its official repository rather than copying an incomplete billing stack into this project.

## Deploy

```bash
git clone https://github.com/getlago/lago.git
cd lago
cp .env.example .env
# Set secure values in .env, then start the official stack.
docker compose up -d
```

Use a tagged Lago release or reviewed commit in production rather than an unpinned moving branch.

## Configure Singh Cloud Emulator

```env
LAGO_API_URL=https://billing.example.com
LAGO_API_KEY=replace-with-the-Lago-API-key
LAGO_WEBHOOK_HMAC_KEY=replace-with-the-Lago-webhook-secret
BILLING_CURRENCY=USD
```

Create a Lago webhook pointing to:

```text
https://emulator.example.com/api/webhooks/lago
```

The webhook handler verifies the HMAC signature and deduplicates Lago's unique event key before updating subscriptions or invoices.

## Suggested billable metrics

Create these event-based metrics in Lago:

- `session_minutes` using the `quantity` property
- `session_count` using event count
- `build_minutes` using the `quantity` property
- `build_count` using event count
- `storage_bytes` using the `quantity` property
- `capture_minutes` using the `quantity` property

The scheduler sends each usage record with a stable transaction ID, allowing retries without duplicate billing.

## Network placement

Keep Lago's PostgreSQL, Redis and worker services private. Expose only Lago's authenticated API and front end through HTTPS. Use distinct databases and secrets from the emulator control plane even when both platforms run on the same host.
