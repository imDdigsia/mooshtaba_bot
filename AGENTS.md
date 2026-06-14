# AGENTS.md — mooshtaba-bot

## What this is

Telegram AI bot running on Cloudflare Workers. TypeScript, no bundler, no Node.js runtime — pure Workers with `wrangler dev` / `wrangler deploy`. Persian-speaking character with mood, memory, and engagement systems.

## Commands

| Task | Command |
|------|---------|
| Type-check | `npm run typecheck` |
| Local dev | `npm run dev` |
| Deploy | `npm run deploy` |
| Tail logs | `npm run tail` |
| Create KV namespaces | `npm run kv:create` |

No test suite, no lint command, no build step. `tsc --noEmit` is the only verification.

## Architecture

Entrypoint: `src/index.ts` (Cloudflare Worker fetch handler).

Three KV namespaces — **MOOD_KV**, **MEMORY_KV**, **ANALYTICS_KV** — created via `wrangler kv namespace create`. IDs are in `wrangler.toml`.

Secrets (never in code): `TELEGRAM_BOT_TOKEN`, `TOKENROUTER_API_KEY`, `TELEGRAM_WEBHOOK_SECRET`, `SETUP_SECRET`. Local: `.dev.vars`. Prod: `wrangler secret put`.

## Code conventions

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess`). No `any`.
- ESM only (`"module": "ES2022"`, `"moduleResolution": "Bundler"`).
- No comments unless asked. No emojis in code.
- Prefer editing existing files. New files only when required.
- Follow existing patterns — look at sibling files before writing new modules.
- All KV reads/writes go through helper functions (see `memory/manager.ts:writeJson`, `analytics/tracker.ts`).

## KV write budget

The free tier allows **1,000 KV put operations/day**. Every put counts. Key write patterns to be aware of:

- **Dedupe**: 1 put per message (`seen:{update_id}`, 1h TTL)
- **Mood**: 1 put on init + 1 put on tick (every 10 min at most)
- **Activity**: 1 put per message (per-minute bucket, 30 min TTL)
- **Memory**: 2–3 puts per message (topics + events + possibly summary)
- **Analytics**: 1 put per request (coalesced via `flush()`)
- **Settings**: only on admin commands (rare)

When modifying code, avoid adding new KV put operations unless absolutely necessary. Prefer in-memory state or batch writes.

## Deployment flow

1. `npm run typecheck`
2. `npm run deploy`
3. Register webhook: `curl -X POST "https://<worker-url>/setup" -H "X-Setup-Secret: <secret>"`

Workers free tier: ~100k req/day. KV free tier: 1k puts/day (the real bottleneck).

## Key gotchas

- Telegram webhook must return 200 fast; processing happens in `ctx.waitUntil`.
- HTML parse mode is used for Telegram messages. Escape user content — never echo raw.
- Memory is bounded: 80 events, 60 topics, 20 jokes. Old events get summarized and dropped.
- Mood has a 10-minute minimum hold to prevent jitter.
- Engagement is probabilistic — the bot intentionally ignores most messages.
