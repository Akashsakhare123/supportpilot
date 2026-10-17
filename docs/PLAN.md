# SupportPilot - Build Plan

> Multi-tenant SaaS: a business adds its knowledge base, embeds a chat widget, and customers get AI answers.
> Low-confidence chats escalate to a human agent in real time.

**Goal:** a portfolio / resume project that recruiters can try live, which can also be sold to freelance clients as a white-label product.
**Duration:** 6 weeks, part time (~18 h/week, ~108 h total).

Status tables and task cards below are generated from [`docs/plan/tasks.json`](plan/tasks.json) by `python scripts/progress.py sync`.
Do not edit the blocks between `AUTO` markers by hand; edit `tasks.json` and re-run sync. Everything else in this file is hand-written.

## Progress

<!-- AUTO:STATUS -->
`[#####---------------] 24%`  **4 / 17 tasks done** (20 / 108 est. hours)  
Last update: 2026-10-17  
**Current / next task:** T05 Chunking and embeddings (Not started)

| ID | Week | Task | Status | Completed |
|---|---|---|---|---|
| [T01](#t01---repo-setup-monorepo) | Week 1 | Repo setup (monorepo) | Done | 2026-10-17 |
| [T02](#t02---auth-with-roles) | Week 1 | Auth with roles | Done | 2026-10-17 |
| [T03](#t03---tenant-onboarding) | Week 1 | Tenant onboarding | Done | 2026-10-17 |
| [T04](#t04---knowledge-base-upload) | Week 2 | Knowledge base upload | Done | 2026-10-17 |
| [T05](#t05---chunking-and-embeddings) | Week 2 | Chunking and embeddings | Not started |  |
| [T06](#t06---background-ingestion-job) | Week 2 | Background ingestion job | Not started |  |
| [T07](#t07---rag-chat-api) | Week 3 | RAG chat API | Not started |  |
| [T08](#t08---embeddable-widget) | Week 3 | Embeddable widget | Not started |  |
| [T09](#t09---agent-inbox) | Week 4 | Agent inbox | Not started |  |
| [T10](#t10---handoff-logic) | Week 4 | Handoff logic | Not started |  |
| [T11](#t11---typing-presence-history) | Week 4 | Typing, presence, history | Not started |  |
| [T12](#t12---analytics-dashboard) | Week 5 | Analytics dashboard | Not started |  |
| [T13](#t13---stripe-billing-and-plan-limits) | Week 5 | Stripe billing and plan limits | Not started |  |
| [T14](#t14---tests) | Week 6 | Tests | Not started |  |
| [T15](#t15---security-hardening) | Week 6 | Security hardening | Not started |  |
| [T16](#t16---cicd-and-deployment) | Week 6 | CI/CD and deployment | Not started |  |
| [T17](#t17---readme-architecture-diagram-demo-video) | Week 6 | README, architecture diagram, demo video | Not started |  |
<!-- /AUTO:STATUS -->

## Milestones

<!-- AUTO:MILESTONES -->
| Week | Dates | Milestone | Release | Outcome | Progress |
|---|---|---|---|---|---|
| Week 1 | Oct 19 - Oct 25 | M1 Foundation | v0.1.0 | Monorepo runs locally, users can sign up as a business and log in with roles. | 3/3 |
| Week 2 | Oct 26 - Nov 1 | M2 Knowledge base | v0.2.0 | Docs (PDF / text / URL) are ingested in the background into pgvector. | 1/3 |
| Week 3 | Nov 2 - Nov 8 | M3 AI chat MVP | v0.3.0 | First demo: a script-tag widget answers from the tenant's docs with sources. | 0/2 |
| Week 4 | Nov 9 - Nov 15 | M4 Human handoff | v0.4.0 | Low-confidence chats escalate to a live agent inbox in real time. | 0/3 |
| Week 5 | Nov 16 - Nov 22 | M5 Business features | v0.5.0 | Analytics (incl. unanswered questions) and Stripe billing with plan limits. | 0/2 |
| Week 6 | Nov 23 - Nov 29 | M6 Production ready | v1.0.0 | Tested, hardened, deployed live with README, diagram and demo video. | 0/4 |
<!-- /AUTO:MILESTONES -->

## Scope

**MVP (must ship):** everything in T01-T17. The product loop is: sign up -> upload docs -> embed widget -> AI answers with sources -> low confidence hands off to a live agent -> analytics and billing.

**Standout features (what makes this different from a tutorial project):**

| Feature | Why it stands out | Task |
|---|---|---|
| Unanswered questions report | Shows which questions the AI failed on, so the client knows what docs to add | T12 |
| Prompt-injection and PII safeguards | Security in the chat pipeline, which most portfolio projects skip | T15 |
| Widget theming per tenant | Colors, logo, greeting: white-label ready for clients | T03, T08 |
| Eval set | A test set of questions that scores answer quality in CI | T14 |

**Stretch (only after v1.0):** Slack / email notifications for agents, multilingual answers, website crawler (whole sitemap), canned replies, WhatsApp channel, custom domain for the widget.

## Critical path

```mermaid
flowchart LR
  T01[T01 Repo] --> T02[T02 Auth] --> T03[T03 Tenants]
  T03 --> T04[T04 KB upload] --> T05[T05 Embeddings] --> T06[T06 Worker]
  T06 --> T07[T07 RAG chat] --> T08[T08 Widget] --> T09[T09 Inbox]
  T09 --> T10[T10 Handoff] --> T11[T11 Typing/presence]
  T10 --> T12[T12 Analytics]
  T07 --> T13[T13 Billing]
  T11 & T12 & T13 --> T14[T14 Tests] --> T15[T15 Security]
  T14 --> T16[T16 CI/CD + deploy] --> T17[T17 README + demo]
```

T07 (RAG chat) is the biggest and riskiest task. If a week slips, cut from T11 (read receipts) and T12 (CSV export) first, never from T14-T15.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM / embedding API cost during development | Small demo corpus, cache embeddings by content hash, cheap models in dev, eval runs only on demand / weekly |
| Answer quality is inconsistent | Eval set (T14) gives a score to compare prompt and chunking changes |
| Cross-tenant data leak | tenant_id from token only, scoped repositories, isolation test suite, Postgres RLS (T15) |
| Real-time bugs across instances | Socket.io Redis adapter from day one (T09), tested with 2 API instances |
| Free-tier hosting limits | Railway / Render starter plans; demo tenant with rate limits; widget served from CDN |
| Time overrun (part time) | Tests written alongside each task, so Week 6 is consolidation rather than starting from zero |

## Task details

<!-- AUTO:TASKS -->
### Week 1 (Oct 19 - Oct 25): M1 Foundation

#### T01 - Repo setup (monorepo)

`Done` · est. 4 h · depends on: none · completed 2026-10-17

**Goal:** A pnpm + Turborepo monorepo where `docker compose up` plus `pnpm dev` runs every app locally.

**Subtasks**

- [x] Init pnpm workspace + Turborepo: apps/api (NestJS), apps/worker, apps/dashboard (Next.js), apps/widget (Preact + Vite), packages/db, packages/shared, packages/config
- [x] Shared tsconfig, ESLint, Prettier, Husky + lint-staged, commitlint (Conventional Commits)
- [x] docker-compose.yml: pgvector/pgvector:pg16 + redis:7 with healthchecks and named volumes
- [x] packages/db: Drizzle ORM config and first migration that enables the `vector` extension
- [x] Typed env config validated with zod; .env.example for every app
- [x] GET /health endpoint that checks Postgres and Redis
- [x] Git repository with Conventional Commits, ready to push to GitHub (CI runs on every push)
- [x] scripts/doctor.cmd: one-click Windows setup check (tools, install, database, every check)

**Acceptance criteria**

- [x] Fresh clone: `docker compose up -d && pnpm i && pnpm dev` starts api, dashboard and widget dev server
- [x] GET /health returns {db: ok, redis: ok}
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` pass locally (CI runs the same checks on every push)

**Deliverables:** Monorepo skeleton, docker-compose.yml, .env.example files, Setup doctor script  
**Interview talking point:** Turborepo caches per package, so CI only rebuilds what actually changed.

#### T02 - Auth with roles

`Done` · est. 6 h · depends on: T01 · completed 2026-10-17

**Goal:** Secure dashboard login with role-based access; every request carries a verified tenant context.

**Subtasks**

- [x] tenants, users, refresh_tokens and invites tables (Drizzle); argon2id password hashing (@node-rs/argon2)
- [x] POST /auth/login, /auth/refresh, /auth/logout, GET /auth/me: 15-min access JWT + rotating refresh token in an httpOnly cookie
- [x] Refresh token families with reuse detection (replayed token revokes the whole session)
- [x] JWT claims: sub, tid (tenant), role; global JwtAuthGuard attaches the caller, routes private by default (@Public opts out)
- [x] @Roles(minRole) decorator + global RolesGuard (owner > admin > agent)
- [x] Invite flow: owners invite admins/agents, admins invite agents; single-use 7-day link (printed + returned in dev)
- [x] Dashboard: login page, /api proxy (first-party cookie), middleware redirect, silent refresh, role-aware navigation, team + invite pages
- [x] Demo seed: tenant Acme Bikes with an owner, admin and agent
- [x] Unit tests for guards, tokens and validation; integration tests for login, roles, refresh rotation, logout and invites

**Acceptance criteria**

- [x] An agent calling an admin-only endpoint gets 403 (covered by a test)
- [x] Refresh token rotation works and logout invalidates the refresh token
- [x] Password hashes are never logged or returned by any endpoint

**Deliverables:** Auth + users modules, JWT + roles guards, Login, team and invite pages, Demo seed  
**Interview talking point:** The tenant id comes from the verified token, never from the request body, so users cannot spoof another tenant.

#### T03 - Tenant onboarding

`Done` · est. 5 h · depends on: T02 · completed 2026-10-17

**Goal:** A business signs up and gets a tenant, an owner account and a widget public key in under a minute.

**Subtasks**

- [x] POST /auth/signup creates tenant + owner in one DB transaction and signs the owner in
- [x] Public key generation (pk_live_ + 144-bit random) and a rotation endpoint that invalidates the old key at once
- [x] Branding settings (jsonb): primary colour, logo, greeting, launcher position, with zod validation
- [x] Allowed domains per tenant, normalised (scheme/port/path stripped), enforced against the Origin header
- [x] Onboarding wizard: company name -> branding with live preview -> allowed domains + embed snippet
- [x] Settings page: company, branding, domains, widget key with copy + rotate
- [x] Public GET /widget/config?key=pk_... returns tenant name + branding only; CORS open for widget routes only
- [x] Widget fetches its config and applies the tenant's colour, logo, greeting and position
- [x] Seed: Acme Bikes branding, allowed domains and sample knowledge-base docs (ingested from T04)
- [x] GET / on the API returns a short info document instead of 404

**Acceptance criteria**

- [x] Signup lands on a dashboard showing the embed snippet with that tenant's key
- [x] Rotating the key invalidates the old key immediately
- [x] Widget config endpoint exposes only public fields (test)

**Deliverables:** Signup + onboarding wizard, Settings page, Widget config endpoint, Seed + sample docs  
**Standout feature:** Widget theming per tenant  
**Interview talking point:** The public key identifies the tenant; the allowed-domains check stops someone else embedding a client's widget.

### Week 2 (Oct 26 - Nov 1): M2 Knowledge base

#### T04 - Knowledge base upload

`Done` · est. 5 h · depends on: T03 · completed 2026-10-17

**Goal:** Admins add knowledge from PDF, plain text / markdown, or a public URL.

**Subtasks**

- [x] documents table: title, source_type (pdf/text/url), source, storage key, size, status (queued/processing/ready/failed), error, chunk_count
- [x] POST /documents (multipart, 10 MB limit, extension + magic-byte / UTF-8 checks) and POST /documents/url
- [x] StorageService: local disk now (STORAGE_DIR or .data/uploads, path-traversal safe); S3/R2 driver with the same interface in T16
- [x] SSRF guard (shared): http(s) only, no credentials, DNS resolved and private / loopback / link-local / metadata ranges blocked
- [x] Dashboard Knowledge Base page: drag-and-drop upload, URL import, status badges with auto-refresh, re-index, delete
- [x] Ingestion job queued on create / re-index (BullMQ, 3 attempts, exponential backoff; consumed in T06)
- [x] Tenant-scoped list / delete / re-index (other tenants' ids return 404)

**Acceptance criteria**

- [x] PDF, TXT, MD and URL can be added from the UI and appear with status `queued`
- [x] Oversized or unsupported files are rejected with clear error messages
- [x] URLs resolving to 127.0.0.1 or 169.254.169.254 are rejected (test)

**Deliverables:** Documents API, Knowledge Base page  
**Interview talking point:** URL ingestion is an SSRF risk, so the fetcher resolves DNS and blocks private IP ranges before connecting.

#### T05 - Chunking and embeddings

`Not started` · est. 6 h · depends on: T04

**Goal:** Turn documents into searchable vector chunks, always scoped to one tenant.

**Subtasks**

- [ ] Text extraction: PDF parser, HTML readability for URLs, raw text / markdown
- [ ] Chunker: split on headings / paragraphs, ~500-800 tokens, 10-15% overlap, keep title + heading path as metadata
- [ ] EmbeddingProvider interface (provider + model from env), batched calls with retry and backoff
- [ ] document_chunks table with vector column, HNSW index (vector_cosine_ops) and tenant_id index
- [ ] searchChunks(tenantId, embedding, k) repository function: tenant filter is mandatory
- [ ] Tests: chunk boundaries and overlap; similarity search returns the expected chunk

**Acceptance criteria**

- [ ] A 20-page PDF becomes embedded chunks in Postgres
- [ ] Searching a known phrase returns the right chunk in the top 3
- [ ] Search never returns another tenant's chunk (test)

**Deliverables:** Chunker, Embedding provider, Vector search repository  
**Interview talking point:** One Postgres holds relational data and vectors, so tenant filtering and joins happen in the same query as similarity search.

#### T06 - Background ingestion job

`Not started` · est. 4 h · depends on: T05

**Goal:** Ingestion runs off the request path and is retryable and observable.

**Subtasks**

- [ ] BullMQ `ingestion` queue on Redis, consumed by apps/worker
- [ ] Job pipeline: extract -> chunk -> embed -> upsert, updating documents.status at each step
- [ ] 3 retries with exponential backoff; failed jobs keep the error message
- [ ] Idempotent re-index: replace old chunks in the same transaction
- [ ] Live status updates in the dashboard (Redis pub/sub -> socket, polling as fallback)
- [ ] Worker concurrency limit and graceful shutdown; Bull Board UI in dev

**Acceptance criteria**

- [ ] Upload request returns immediately; the worker processes in the background
- [ ] Killing the worker mid-job: the job retries and completes after restart
- [ ] A failed document shows the reason in the UI and can be retried

**Deliverables:** Worker app, Ingestion queue, Live status badges  
**Interview talking point:** Embedding is slow and rate-limited, so it runs in a queue with retries instead of blocking the upload request.

### Week 3 (Nov 2 - Nov 8): M3 AI chat MVP

#### T07 - RAG chat API

`Not started` · est. 10 h · depends on: T06

**Goal:** Answer customer questions using only the tenant's docs, streamed token by token, with sources and a confidence score.

**Subtasks**

- [ ] conversations + messages tables (status ai/waiting/human/closed; sources jsonb; confidence)
- [ ] Pipeline: PII redaction -> embed question -> top-k chunks for the tenant -> prompt -> streamed LLM answer
- [ ] Prompt rules: answer only from context, otherwise say so; context wrapped as untrusted data; last N messages as memory
- [ ] Structured metadata per answer: confidence (0-1), cited chunk ids, needs_human flag
- [ ] Confidence = blend of retrieval similarity and model self-rating (formula documented in ARCHITECTURE.md)
- [ ] LlmProvider interface; provider and model chosen via env
- [ ] POST /v1/chat with Server-Sent Events, sharing the same ChatService the socket gateway uses
- [ ] Persist every message with sources + confidence; write usage_events

**Acceptance criteria**

- [ ] A question covered by the docs gets a streamed answer with at least one correct citation
- [ ] A question not covered gets an honest 'I don't know' with low confidence
- [ ] First token arrives in under 2 seconds locally

**Deliverables:** ChatService, Streaming endpoint, Confidence scorer  
**Interview talking point:** The model can only answer from retrieved chunks and must cite them, which keeps answers grounded and auditable.

#### T08 - Embeddable widget

`Not started` · est. 8 h · depends on: T07

**Goal:** Any website adds one script tag and gets a branded chat bubble.

**Subtasks**

- [ ] Preact + Vite library build to a single IIFE widget.js, target < 50 KB gzipped
- [ ] Render inside Shadow DOM so host-page CSS and widget CSS never clash
- [ ] Read data-key from the script tag, fetch /widget/config, apply branding
- [ ] Socket.io client on the /widget namespace, authenticated with public key + anonymous visitor id
- [ ] UI: launcher, chat panel, streaming text, source links, 'Talk to a human' button, reconnect state
- [ ] Origin check against the tenant's allowed domains on connect
- [ ] Demo host page and install snippet shown in the dashboard

**Acceptance criteria**

- [ ] Pasting the snippet into a plain HTML file shows a working, branded widget
- [ ] Host-page CSS does not affect the widget and vice versa
- [ ] CI fails if the bundle grows beyond 60 KB gzipped

**Deliverables:** widget.js bundle, Demo page, Install snippet  
**Standout feature:** Widget theming per tenant  
**Interview talking point:** Shadow DOM plus a tiny Preact bundle means the widget drops into any client site without breaking their styles.

### Week 4 (Nov 9 - Nov 15): M4 Human handoff

#### T09 - Agent inbox

`Not started` · est. 7 h · depends on: T07, T08

**Goal:** Agents see live conversations and can jump in from the dashboard.

**Subtasks**

- [ ] Socket.io /agent namespace with JWT auth and the Redis adapter for multiple API instances
- [ ] Rooms: tenant:{id} and conversation:{id}
- [ ] Inbox tabs: Needs agent / Mine / AI-handled / Closed with live unread counts
- [ ] Conversation view: full history with AI sources and confidence visible to agents
- [ ] Agent reply box: message saved as sender_type=agent and pushed to the widget instantly
- [ ] Claim / assign conversation (assigned_agent_id), exclusive claim

**Acceptance criteria**

- [ ] A new widget conversation appears in the inbox without a refresh
- [ ] Two agents in two browsers see the same state; claiming is exclusive
- [ ] Works with 2 API instances running (Redis adapter)

**Deliverables:** Agent gateway, Inbox page, Conversation view  
**Interview talking point:** The Redis adapter fans socket events out across API instances, so the app scales horizontally.

#### T10 - Handoff logic

`Not started` · est. 6 h · depends on: T09

**Goal:** Low-confidence or explicit requests move the chat to a human, and back to AI when done.

**Subtasks**

- [ ] Conversation state machine: ai -> waiting -> human -> ai | closed, all transitions in one service
- [ ] Triggers: confidence below tenant threshold (default 0.55), 'Talk to a human' button, intent phrases, 2 low-confidence answers in a row
- [ ] Waiting state: customer sees 'Connecting you to an agent', inbox highlights and notifies
- [ ] While status = human the AI pipeline is skipped for that conversation
- [ ] Agent actions: hand back to AI, close conversation
- [ ] No agent online: collect the customer's email and save it as an offline ticket
- [ ] Tenant setting: confidence threshold slider
- [ ] Unit tests for every valid and invalid transition

**Acceptance criteria**

- [ ] A low-confidence question shows under 'Needs agent' within 1 second
- [ ] The AI never replies while status = human (test)
- [ ] Handing back to AI resumes AI answers

**Deliverables:** Handoff state machine, Threshold setting, Offline ticket fallback  
**Interview talking point:** Handoff is an explicit state machine, so every transition is validated and testable instead of scattered if-statements.

#### T11 - Typing, presence, history

`Not started` · est. 5 h · depends on: T10

**Goal:** The chat feels live: typing indicators, agent presence, and history that survives reloads.

**Subtasks**

- [ ] Typed socket event contract in packages/shared (zod) used by api, dashboard and widget
- [ ] Throttled typing:start / typing:stop in both directions
- [ ] Agent presence (online / away / offline) in Redis with TTL heartbeats; widget shows 'agents online'
- [ ] Paginated message history on widget reopen and in the agent view
- [ ] Read receipts and unread counts
- [ ] Reconnect + missed-message sync (fetch since lastMessageId)

**Acceptance criteria**

- [ ] Typing shows on the other side within ~300 ms
- [ ] Closing and reopening the widget restores the conversation
- [ ] Agent presence flips to offline when the tab closes (TTL expiry)

**Deliverables:** Shared event contract, Presence service, History pagination  
**Interview talking point:** Presence uses Redis keys with TTL heartbeats, so crashed clients go offline automatically.

### Week 5 (Nov 16 - Nov 22): M5 Business features

#### T12 - Analytics dashboard

`Not started` · est. 7 h · depends on: T10

**Goal:** Show the client the value of the AI and exactly which docs are missing.

**Subtasks**

- [ ] KPIs: conversations, AI-resolved %, handoff %, avg first response time, thumbs up/down rating
- [ ] Top questions: group similar questions by embedding similarity
- [ ] Unanswered questions report: low-confidence / handed-off questions grouped, with an 'Add doc' shortcut
- [ ] Date range filter, charts (Recharts), Redis cache for 5 minutes
- [ ] CSV export

**Acceptance criteria**

- [ ] Seeded demo data shows meaningful charts
- [ ] Unanswered report lists questions the AI failed on, with counts
- [ ] Every analytics query is tenant-scoped (test)

**Deliverables:** Analytics API, Analytics page, Unanswered questions report  
**Standout feature:** Unanswered questions report  
**Interview talking point:** The unanswered-questions report turns AI failures into a to-do list of docs the client should write.

#### T13 - Stripe billing and plan limits

`Not started` · est. 8 h · depends on: T03, T07

**Goal:** Real SaaS billing: plans, upgrades and limits enforced from usage.

**Subtasks**

- [ ] Plans in config: Free (100 AI msgs/mo, 5 docs, 1 agent), Pro, Business
- [ ] Stripe Checkout for upgrades and Customer Portal for manage / cancel
- [ ] Webhook endpoint with signature verification, idempotent by event id
- [ ] Handle checkout.session.completed, customer.subscription.updated / deleted, invoice.payment_failed
- [ ] subscriptions table synced from webhooks (Stripe is the source of truth)
- [ ] PlanLimitGuard reads monthly usage_events; at the limit the widget falls back to 'leave a message'
- [ ] Billing page: current plan, usage meters, upgrade CTA

**Acceptance criteria**

- [ ] Test-mode upgrade works end to end (Stripe CLI webhook forwarding)
- [ ] Exceeding the Free limit blocks AI answers gracefully
- [ ] A replayed webhook does not double-apply

**Deliverables:** Billing module, Webhook handler, Billing page  
**Interview talking point:** Webhooks are verified and idempotent, and plan state is derived from Stripe, never trusted from the client.

### Week 6 (Nov 23 - Nov 29): M6 Production ready

#### T14 - Tests

`Not started` · est. 8 h · depends on: T13

**Goal:** Prove it works: automated tests on every PR plus a measurable answer-quality score.

**Subtasks**

- [ ] Unit: chunker, confidence scorer, handoff state machine, guards, PII redactor (written alongside each task, consolidated here)
- [ ] Integration: API against real Postgres/pgvector + Redis (CI service containers)
- [ ] Tenant isolation suite: tenant A can never read tenant B's docs, chunks or conversations through any endpoint
- [ ] E2E (Playwright): signup -> upload doc -> ask in widget -> handoff -> agent reply
- [ ] Eval set: 30-40 questions for the demo tenant (answerable, unanswerable, injection attempts)
- [ ] Eval scorer: retrieval hit@k, answer correctness, correct-refusal rate; writes a report
- [ ] Coverage report; target >= 70% on core services

**Acceptance criteria**

- [ ] CI runs unit + integration tests on every PR
- [ ] Eval workflow publishes a score report; the baseline is recorded in docs
- [ ] Isolation suite passes

**Deliverables:** Test suites, Eval set + scorer, Coverage report  
**Standout feature:** Eval set  
**Interview talking point:** The eval set turns 'the AI seems good' into a number that CI tracks across prompt and model changes.

#### T15 - Security hardening

`Not started` · est. 6 h · depends on: T14

**Goal:** Close the gaps most portfolio projects leave open.

**Subtasks**

- [ ] Rate limiting per IP and per tenant (Redis store) on auth, widget and chat; socket message rate limit
- [ ] Prompt-injection defense: user input and retrieved docs treated as untrusted data, system prompt never echoed, pattern checks, output filter
- [ ] PII redaction (emails, phones, card numbers with Luhn check) before LLM calls and in logs
- [ ] Postgres Row-Level Security on tenant tables as defense in depth (app.tenant_id set per transaction)
- [ ] Helmet, strict CORS, input validation everywhere, dependency audit
- [ ] docs/SECURITY.md: one-page threat model

**Acceptance criteria**

- [ ] A burst of 100 requests/second from one IP receives 429s
- [ ] Injection prompts from the eval set do not change behavior
- [ ] PII is masked in stored logs and in the LLM payload (test)
- [ ] RLS blocks a cross-tenant query even with the app filter removed (test)

**Deliverables:** Rate limiter, Injection + PII guards, RLS policies, SECURITY.md  
**Standout feature:** Prompt-injection and PII safeguards  
**Interview talking point:** Tenant isolation has three layers: token-derived context, scoped repositories, and Postgres RLS as a safety net.

#### T16 - CI/CD and deployment

`Not started` · est. 7 h · depends on: T14

**Goal:** Merge to main and it is live, with no manual steps.

**Subtasks**

- [ ] Multi-stage Dockerfiles for api and worker (node:22-alpine, non-root, small images)
- [ ] Finish ci.yml: docker build check and widget bundle-size check
- [ ] Dashboard + widget CDN on Vercel; api, worker, Postgres (pgvector) and Redis on Railway (Render as fallback)
- [ ] deploy.yml: migrate DB -> deploy api/worker -> deploy dashboard -> smoke test /health
- [ ] GitHub Environments with secrets; Vercel preview deploys for PRs
- [ ] Production demo tenant seeded + public demo page
- [ ] Uptime monitor and error tracking (Sentry free tier)

**Acceptance criteria**

- [ ] Merge to main goes live in under 10 minutes without manual steps
- [ ] Public demo URL works on desktop and mobile
- [ ] Rollback steps documented in PIPELINE.md

**Deliverables:** Dockerfiles, Deploy workflow, Live demo URL  
**Interview talking point:** Every PR runs lint, types, tests against real Postgres + Redis, and a bundle-size budget before it can merge.

#### T17 - README, architecture diagram, demo video

`Not started` · est. 6 h · depends on: T16

**Goal:** A recruiter understands the project in 60 seconds; a client sees something they would pay for.

**Subtasks**

- [ ] README: hero GIF, live demo + demo login, features, diagram, stack, multi-tenancy explainer, 3-command setup, test + eval results
- [ ] Architecture diagram exported as PNG/SVG (Mermaid source kept in docs)
- [ ] 2-3 min demo video: signup -> upload -> widget answer with sources -> handoff -> agent reply -> analytics -> billing
- [ ] Portfolio case study / LinkedIn post
- [ ] Client-facing one-pager (white-label pitch) and final pass on the Word project document

**Acceptance criteria**

- [ ] Someone new can run the project locally by following only the README
- [ ] README, demo video and live URL are linked from resume / portfolio

**Deliverables:** Final README, Architecture diagram, Demo video, Client one-pager  
**Interview talking point:** Walk through the demo video live: it shows the whole product loop in under three minutes.
<!-- /AUTO:TASKS -->
