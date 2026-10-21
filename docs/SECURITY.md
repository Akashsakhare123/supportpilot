# SupportPilot - Security (threat model)

One page: what we protect, from whom, and the control that stops each threat. Every control
listed as tested has an automated test (`apps/api/test/security.int-spec.ts`,
`isolation.int-spec.ts`, `billing.int-spec.ts` and the unit suites).

**Assets:** each business's knowledge base, customer conversations (may contain PII), team
accounts, widget keys, billing state, and the AI budget (LLM calls cost money).
**Actors:** anonymous website visitors (anyone on the internet can load the widget), signed-in
team members of *other* tenants, attackers with a stolen or guessed credential, and malicious
content inside uploaded documents or customer messages (prompt injection).

## Controls

| Threat | Control | Tested |
|---|---|---|
| **Cross-tenant data access** | Three layers. 1) The tenant id comes only from the verified JWT (or the widget key), never from the request body. 2) Every query filters `tenant_id`; services return 404 for other tenants' ids. 3) **Postgres row-level security** on every tenant table: inside `withTenant()` the connection switches to the `supportpilot_app` role with `app.tenant_id` set, so a query that forgot its filter still only sees (and can only write) that tenant's rows; with no tenant set the role sees nothing (fail closed). Used for vector search, analytics and the inbox's raw SQL. | Isolation suite (every endpoint, route census), RLS tests with the app filter removed |
| **Brute force, floods, cost attacks** | Redis rate limits shared by all API instances: 50 requests / 5 s per address on everything, 10 logins / signups / invite accepts a minute, 30 refreshes a minute, 20 widget chat messages a minute per address, 600 chat messages a minute per tenant, 30 widget socket connections a minute per address, plus per-socket limits (one answer at a time, 20 messages a minute, typing and rating floods). 429 with `Retry-After`. X-Forwarded-For is only trusted from `TRUST_PROXY`. Plan limits cap AI answers per month. | Burst of 120 requests -> 429s, 11th login -> 429, 21st chat -> 429 |
| **Prompt injection** | The system prompt marks customer text and passages as untrusted data and the passages are wrapped in neutralised tags (T07). Since T15: instruction-like sentences and fake `<instructions>` blocks are stripped from the question before retrieval and generation (a pure attack gets a fixed reply, no model call); the stream passes through a `LeakGuard` that cuts the answer off before any part of the system prompt or metadata format is shown, and a final check replaces a leaking answer. Attempts are logged and stored as message metadata. | Eval set injection cases (6 of 7 pass offline; the 7th fails the same way as its plain question), same answer with and without an injected instruction, simulated leaking model never reaches the customer |
| **PII leakage** | Emails, phone numbers and card numbers (Luhn-checked) are masked before every LLM and embedding call and in analytics; agents still see the original message. The API logger (`RedactingLogger`) masks the same patterns in every log line, error and stack trace. | LLM payload has `[email]`, stored message keeps the original; logger never writes PII to stdout / stderr |
| **Credential theft** | argon2 password hashes, 15-minute access tokens in memory only, rotating httpOnly refresh cookie with reuse detection, invite tokens stored hashed | Auth suite (T02) |
| **Widget on a foreign site** | Allowed domains checked against the Origin on the socket handshake and the REST API; public keys are rotatable | Widget suites (T03, T08) |
| **SSRF via URL import** | DNS resolution and private / loopback / metadata ranges blocked, size and time limits | Documents suite (T04) |
| **Malicious uploads** | Size limit, extension + magic-byte checks, parsing only in the worker | Documents and worker suites (T04, T06) |
| **Forged billing events** | Stripe signature over the raw body, idempotent by event id, plan state re-read from Stripe and never taken from the client | Billing suite (T13) |
| **Browser attacks on the dashboard** | Helmet headers on the API (HSTS, nosniff, frame-ancestors, no X-Powered-By); X-Frame-Options DENY, nosniff, Referrer-Policy and Permissions-Policy on the dashboard; strict CORS with credentials only for the dashboard origins; the access token never touches localStorage | Header test |
| **Vulnerable dependencies** | `pnpm audit --prod --audit-level high` fails CI; Dependabot opens update PRs; drizzle-orm upgraded to 0.45 (identifier escaping fix) and PostCSS pinned to >= 8.5.23 in T15 | CI |
| **Bad input** | zod schemas on every body, query and socket event (strict objects, length limits) | Every suite |

## Known gaps and accepted risks

- **Row-level security covers the raw-SQL and search paths**, not every ORM query: the other
  queries rely on the tenant filter and the isolation suite. Moving all request-scoped queries into
  `withTenant()` is a mechanical follow-up.
- **The worker, migrations and seeds run as the table owner**, which bypasses RLS by design (they
  work across tenants). They take tenant ids only from queued jobs the API created.
- **Injection patterns are heuristics.** They target instructions aimed at the assistant and are
  kept narrow to avoid blocking real questions; the prompt rules and the leak guard are the backstop.
  A real-model eval run (`EVAL_PROVIDER=openai`) is the way to measure this beyond the offline baseline.
- **Dev-only advisories** (vitest / tinypool, esbuild in drizzle-kit and tsup, lint-staged's braces,
  jest's sprintf-js) do not ship to production; they are upgraded through Dependabot.
- **Rate limits fail open** if Redis is unreachable (logged), so a Redis outage does not take the
  product down; Redis health is part of `/health`.

## Reporting

Security issues: email the maintainer instead of opening a public issue.
