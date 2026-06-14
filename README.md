# Mooshtaba Bot 🐭

Persian-speaking Telegram AI bot running on Cloudflare Workers with mood engine, memory, analytics, and interactive admin menus.

> **Support the project:** Sign up at [prox.us.ci](https://ai.prox.us.ci/sign-up?aff=35Fw) using our referral link!
> **Join our community:** [dc.hhhl.cc](https://dc.hhhl.cc)

## Features

- **Mood Engine** — Dynamic personality states (excited, sleepy, chaotic, curious, etc.)
- **Memory System** — Remembers conversations, topics, jokes, and nicknames
- **Analytics** — Message tracking, response stats, topic analysis
- **Interactive Menus** — Inline keyboard admin panel with edit-in-place navigation
- **Whitelist** — Control which chats the bot responds to
- **Admin-Only Mode** — Restrict bot to admins only, with whitelist bypass

## Prerequisites

- Node.js 18+
- npm
- Git
- Cloudflare account (free tier works)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- **[prox.us.ci](https://ai.prox.us.ci/sign-up?aff=35Fw) API key** — Sign up using our referral link to support the project
-You must have an account at [dc.hhhl.cc](https://dc.hhhl.cc)

## Quick Deploy

### Option 1: Deployment Wizard (Recommended)

```powershell
# Clone the repo
git clone https://github.com/YOUR_USERNAME/mooshtaba_bot.git
cd mooshtaba_bot

# Install dependencies
npm install

# Run the wizard
.\deploy-wizard.ps1
```

The wizard will:
1. Check prerequisites (Node.js, npm, Wrangler, Git)
2. Guide you through setting up secrets
3. Create D1 database and run schema migration
4. Deploy to Cloudflare Workers
5. Register the Telegram webhook

### Option 2: Manual Deploy

```bash
# Install dependencies
npm install

# Set up secrets locally
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values

# Set production secrets
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TOKENROUTER_API_KEY
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put SETUP_SECRET

# Create D1 database
wrangler d1 create mooshtaba-db
# Update database_id in wrangler.toml

# Run schema
wrangler d1 execute mooshtaba-db --file=src/db/schema.sql --remote

# Deploy
npm run deploy

# Register webhook
curl -X POST "https://YOUR_WORKER_URL/setup" \
  -H "X-Setup-Secret: YOUR_SETUP_SECRET"
```

## Configuration

### Environment Variables (wrangler.toml)

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_IDS` | Comma-separated Telegram user IDs | Required |
| `ADMIN_ONLY` | Only admins can use bot | `true` |
| `ALLOWED_CHAT_IDS` | Comma-separated chat IDs | Empty = all |
| `BOT_NICKNAME` | Bot's display name | `موشتبی` |
| `TIMEZONE` | Bot timezone | `Asia/Tehran` |
| `LOG_LEVEL` | Logging level | `info` |

### Secrets

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TOKENROUTER_API_KEY` | From prox.us.ci |
| `TELEGRAM_WEBHOOK_SECRET` | Auto-generated |
| `SETUP_SECRET` | Auto-generated |

## Development

```bash
# Local development
npm run dev

# Type check
npm run typecheck

# View live logs
npm run tail
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + main menu |
| `/help` | Command reference |
| `/mood` | View/change bot mood |
| `/memory` | View conversation memory |
| `/stats` | View analytics |
| `/whitelist` | Manage chat whitelist |
| `/adminonly` | Toggle admin-only mode |

## Architecture

- **Runtime:** Cloudflare Workers (free tier)
- **Database:** Cloudflare D1 (SQLite)
- **AI Provider:** prox.us.ci (OpenAI-compatible)
- **Language:** TypeScript (strict mode)

## License

MIT
