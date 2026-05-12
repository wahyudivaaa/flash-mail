# Flash Mail Flare

Flash Mail Flare is a self-hosted email inbox dashboard built on Cloudflare Workers, Cloudflare D1, and Cloudflare Email Routing. It lets you create mailbox users for your own domains, receive inbound email inside the web app, manage users, inspect inboxes, generate API keys, and optionally forward notifications to Telegram.

The project is designed for personal, team, QA, and automation workflows where you control the domain and want a lightweight email receiving system without running a VPS.

## Features

- Cloudflare Email Routing Worker for inbound email.
- Web inbox for admins and members.
- Admin dashboard with users, inbox metrics, and worker settings.
- User creation with generated passwords.
- Multiple managed domains through Cloudflare.
- GPT Plus status detector from inbound OpenAI emails.
- Gmail/custom-domain dot alias generator for GPT accounts and a standalone saved dot-alias page.
- Public API v1 for user creation and mailbox reading.
- Telegram bot integration for notifications and admin commands.
- Optional Outlook/Microsoft 365 planning endpoints.
- Indonesian and English language switcher.
- SweetAlert-powered confirmation and notification dialogs.

## Tech Stack

- SvelteKit
- TypeScript
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Email Routing
- Cloudflare Turnstile
- Wrangler
- pnpm
- PostalMime
- SweetAlert2

## Requirements

- Node.js 20 or newer
- pnpm
- Git
- Cloudflare account
- A domain added to Cloudflare
- Cloudflare Email Routing available on that domain
- Wrangler login access to the Cloudflare account

Optional integrations:

- Telegram bot token for notifications
- Microsoft Entra application and Microsoft 365 license for Outlook automation

## Quick Start

Clone the repository:

```bash
git clone https://github.com/wahyudivaaa/flash-mail.git
cd flash-mail
```

Install dependencies:

```bash
pnpm install
```

Copy local environment examples:

```bash
cp .dev.vars.example .dev.vars
cp wrangler.toml.example wrangler.toml
```

On Windows PowerShell:

```powershell
Copy-Item .dev.vars.example .dev.vars
Copy-Item wrangler.toml.example wrangler.toml
```

Edit `.dev.vars` and `wrangler.toml` for your own Cloudflare account, domain, database, and secrets.

Run type checks:

```bash
pnpm check
```

Run local Cloudflare development mode:

```bash
pnpm cf:dev
```

By default the local worker uses the port configured in `wrangler.toml` under `[dev]`.

## Cloudflare Setup

### 1. Login to Wrangler

```bash
pnpm exec wrangler login
```

Follow the browser authorization flow.

### 2. Create a D1 Database

```bash
pnpm exec wrangler d1 create flash-mail-db
```

Copy the returned `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "flash-mail-db"
database_id = "<your-d1-database-id>"
```

### 3. Apply the Schema

For local development:

```bash
pnpm exec wrangler d1 execute flash-mail-db --local --file ./schema.sql
```

For production:

```bash
pnpm exec wrangler d1 execute flash-mail-db --remote --file ./schema.sql
```

If you use the incremental migrations folder instead of the consolidated schema, apply them in order:

```bash
pnpm exec wrangler d1 execute flash-mail-db --remote --file ./migrations/0001_gpt_plus_claims.sql
pnpm exec wrangler d1 execute flash-mail-db --remote --file ./migrations/0002_gpt_plus_deactivation.sql
pnpm exec wrangler d1 execute flash-mail-db --remote --file ./migrations/0003_user_email_aliases.sql
pnpm exec wrangler d1 execute flash-mail-db --remote --file ./migrations/0004_dot_alias_generations.sql
```

### 4. Configure `wrangler.toml`

Start from `wrangler.toml.example`:

```toml
name = "mailflare-web"
main = ".svelte-kit/cloudflare/_worker.js"
compatibility_date = "2026-04-07"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
preview_urls = false

[[routes]]
pattern = "mail.example.com"
custom_domain = true

[vars]
MAILFLARE_USER_DOMAIN = "example.com"
MAILFLARE_NOTIFY_URL = "https://mail.example.com"
CLOUDFLARE_ACCOUNT_ID = "<cloudflare-account-id>"
CLOUDFLARE_ZONE_ID = "<cloudflare-zone-id>"
CLOUDFLARE_ZONE_NAME = "example.com"
MAILFLARE_EMAIL_WORKER_NAME = "mailflare-web"
```

Do not commit your real `wrangler.toml`. It is ignored by Git because it can contain deployment-specific identifiers.

### 5. Set Production Secrets

Use Wrangler secrets for sensitive values:

```bash
pnpm exec wrangler secret put SETUP_TOKEN
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put TELEGRAM_INTERNAL_SECRET
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
```

Optional Outlook/Microsoft 365 secrets:

```bash
pnpm exec wrangler secret put OUTLOOK_TENANT_ID
pnpm exec wrangler secret put OUTLOOK_CLIENT_ID
pnpm exec wrangler secret put OUTLOOK_CLIENT_SECRET
pnpm exec wrangler secret put OUTLOOK_LICENSE_SKU_ID
```

## Email Routing Setup

Flash Mail Flare receives email through a Worker email handler that is injected during build by `scripts/postbuild-add-email-handler.mjs`.

Minimum flow:

1. Add your domain to Cloudflare.
2. Enable Email Routing for the zone.
3. Configure Email Routing DNS records from Cloudflare.
4. Create Email Routing rules that send mailbox addresses to the Worker.
5. Deploy this app.

The app includes automation helpers for managed domains:

```bash
pnpm cf:mail-domain:setup -- --domain example.com
```

The automation requires:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MAILFLARE_EMAIL_WORKER_NAME`

For production, store the API token as a Worker secret. For local runs, place it in `.dev.vars`.

## First Login

When the first user logs in, the app bootstraps the first owner account.

1. Open the deployed app URL.
2. Enter an email/username and password.
3. Enter the `SETUP_TOKEN`.
4. The first account becomes the owner.

After the owner exists, normal users are created from the admin dashboard or the public API.

## Main Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run SvelteKit dev server without full Cloudflare bindings. |
| `pnpm cf:dev` | Build and run `wrangler dev` with Cloudflare bindings. |
| `pnpm check` | Run SvelteKit sync and TypeScript/Svelte diagnostics. |
| `pnpm build` | Build the Cloudflare Worker bundle and inject the email handler. |
| `pnpm run deploy` | Build and deploy to Cloudflare. |
| `pnpm cf:mail-domain:setup` | Set up a Cloudflare zone/domain for Mail Flare usage. |
| `pnpm telegram:webhook:set` | Register Telegram webhook. |
| `pnpm telegram:webhook:delete` | Delete Telegram webhook. |
| `pnpm telegram:webhook:info` | Read Telegram webhook status. |
| `pnpm telegram:commands` | Register Telegram bot commands. |
| `pnpm smoke:api-key:v1` | Run local smoke tests for public API key flow. |

## Public API v1

Generate or rotate an API key from the Worker Settings page.

Supported authentication:

```http
x-api-key: <api-key>
```

or:

```http
authorization: Bearer <api-key>
```

Available endpoints:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/public/v1/create_user` | Create a mailbox user. |
| `GET` | `/api/public/v1/list_user` | List active mailbox users. |
| `GET` | `/api/public/v1/user_mailbox` | Read a user's mailbox. |
| `GET` | `/api/public/v1/read_email` | Read a rendered email body. |
| `GET` | `/api/public/v1/read_emai` | Backward-compatible alias for `read_email`. |

Example create user:

```bash
curl -X POST "https://mail.example.com/api/public/v1/create_user" \
  -H "content-type: application/json" \
  -H "x-api-key: <api-key>" \
  -d '{"username":"demo","domain":"example.com"}'
```

Example list users:

```bash
curl "https://mail.example.com/api/public/v1/list_user" \
  -H "x-api-key: <api-key>"
```

## Telegram Integration

Telegram is optional. It can:

- Send inbound email notifications.
- Generate one-time access codes.
- Create users through bot commands.
- Rotate or display public API key status.

Recommended production setup:

```bash
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put TELEGRAM_INTERNAL_SECRET
```

Set the webhook:

```bash
pnpm telegram:webhook:set -- \
  --token "<bot-token>" \
  --url "https://mail.example.com/api/telegram/webhook" \
  --secret "<webhook-secret>"
```

See `docs/integrasi-telegram-bot.md` for the detailed Telegram guide.

## Domain and User Model

Current stable model:

- One deployed app instance.
- One D1 database.
- One owner account.
- Multiple mailbox users.
- Multiple managed domains can be configured by the owner.

This repository is best used as a self-hosted or managed single-tenant instance. If you want to turn it into a true multi-tenant SaaS, add tenant-aware tables and enforce `tenant_id` in every query before onboarding unrelated customers into the same database.

## GPT Plus Tools

The GPT Plus page detects plan activation and deactivation emails from inbound messages. It stores useful account metadata such as:

- mailbox email
- first generated password
- detected plan email date
- expiration estimate
- deactivation state

For Gmail and managed-domain accounts, the page also includes a dot-alias generator. For managed Cloudflare domains, activated dot aliases are stored in D1 and connected to Cloudflare Email Routing.

## Dot Alias Generator

The standalone `/dot-aliases` page accepts one source email, generates up to 1,000 safe dot-trick variations, stores the generated batch in D1, and shows a searchable history. If the source email already belongs to an active Mail Flare user on a managed Cloudflare domain, the backend also stores a safe first batch against that user and attempts to create Cloudflare Email Routing rules automatically.

## Outlook / Microsoft 365 Notes

Outlook automation is optional and requires Microsoft Graph configuration:

- `OUTLOOK_TENANT_ID`
- `OUTLOOK_CLIENT_ID`
- `OUTLOOK_CLIENT_SECRET`
- `OUTLOOK_LICENSE_SKU_ID`
- `OUTLOOK_INITIAL_DOMAIN`

The system can produce DNS guidance and mailbox creation requests, but a valid Microsoft 365 tenant and available licenses are required.

## Security Notes

Never commit:

- `.dev.vars`
- `.env`
- real `wrangler.toml`
- API tokens
- Telegram bot tokens
- Microsoft client secrets
- Cloudflare API tokens
- local `.wrangler/` state
- build output
- logs
- browser automation state
- local AI assistant config folders

Use `wrangler secret put` for production secrets.

Sensitive runtime values should be rotated if they were ever committed or pasted into public logs.

## Project Structure

```text
cloud-mail-flare/
  docs/                         Extra documentation
  migrations/                   Incremental D1 migrations
  scripts/                      Build, deployment, Telegram, and Cloudflare helpers
  src/
    lib/
      components/               UI components
      config/                   App branding/config helpers
      server/                   D1, Cloudflare, Telegram, auth, and service logic
      types/                    Shared DTO types
    routes/                     SvelteKit pages and API routes
  static/                       Static assets
  schema.sql                    Consolidated D1 schema
  wrangler.toml.example         Safe Cloudflare config template
  .dev.vars.example             Safe local secrets template
```

## Troubleshooting

### D1 binding is missing

Use `pnpm cf:dev` instead of `pnpm dev` when testing Worker/D1 functionality.

### Email does not arrive

Check:

- Cloudflare Email Routing is enabled.
- MX/TXT records are configured.
- The domain exists in Worker Settings.
- The mailbox user exists.
- Routing rule sends the address to the Worker.
- The deployed Worker name matches `MAILFLARE_EMAIL_WORKER_NAME`.

### Login CAPTCHA fails

Check:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- domain allowed in Cloudflare Turnstile settings

### Telegram notification fails

Check:

- bot token is valid
- webhook URL points to `/api/telegram/webhook`
- webhook secret matches
- `TELEGRAM_INTERNAL_SECRET` is configured if calling notify endpoint externally
- `MAILFLARE_NOTIFY_URL` points to the deployed app URL

### Deployment fails on Windows

Run:

```bash
pnpm build
```

The prebuild script cleans stale build cache before SvelteKit builds the Worker bundle.

## License

No license file is included yet. Add a license before publishing this project for public reuse.
