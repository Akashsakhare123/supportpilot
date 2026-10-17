# SupportPilot

**AI customer support platform: a multi-tenant RAG chat widget with real-time human handoff.**

A business uploads its knowledge base, pastes one `<script>` tag on its site, and its customers get instant answers grounded in that business's own docs, with sources. When the AI is not confident, or the customer asks for a person, the conversation moves to a live agent inbox in real time.

> Status: in active development. Live demo, demo video and setup instructions land in Week 6 (see progress below).

## Progress

<!-- AUTO:PROGRESS -->
![progress](https://img.shields.io/badge/progress-7%2F17%20tasks-3B3F8C)

`[########------------] 41%` - currently on **T08 Embeddable widget**

| Milestone | Release | Progress |
|---|---|---|
| M1 Foundation | v0.1.0 | 3/3 (done) |
| M2 Knowledge base | v0.2.0 | 3/3 (done) |
| M3 AI chat MVP | v0.3.0 | 1/2 (in progress) |
| M4 Human handoff | v0.4.0 | 0/3 (planned) |
| M5 Business features | v0.5.0 | 0/2 (planned) |
| M6 Production ready | v1.0.0 | 0/4 (planned) |

Full plan: [docs/PLAN.md](docs/PLAN.md) · Build log: [docs/PROGRESS.md](docs/PROGRESS.md)
<!-- /AUTO:PROGRESS -->

## Features

- **Bring your own knowledge base:** upload PDF, text / markdown, or a URL; ingested in the background into pgvector
- **Grounded AI answers:** retrieval-augmented generation, streamed token by token, with source citations and a confidence score
- **One-line embeddable widget:** tiny Preact bundle in Shadow DOM, themed per tenant (colors, logo, greeting)
- **Real-time human handoff:** low confidence or "talk to a human" escalates to the agent inbox instantly; agents can hand back to AI
- **Live chat details:** typing indicators, agent presence, message history, reconnect sync
- **Analytics:** AI vs. human resolution, top questions, and an **unanswered questions report** that tells the client which docs to add
- **SaaS billing:** Stripe subscriptions with plan limits enforced from usage events
- **Security:** strict tenant isolation (scoped queries + Postgres RLS), rate limiting, prompt-injection and PII safeguards
- **Quality:** unit, integration and E2E tests plus an **eval set** that scores answer quality in CI

## Tech stack

| Layer | Choice |
|---|---|
| Dashboard | Next.js, TypeScript, Tailwind, shadcn/ui |
| Widget | Preact + Vite (single IIFE bundle, Shadow DOM) |
| API | NestJS (TypeScript), REST + Socket.io gateway |
| Real-time | Socket.io with Redis adapter |
| Database | PostgreSQL + pgvector, Drizzle ORM |
| Queues / cache | Redis + BullMQ |
| AI | LLM + embeddings API behind provider interfaces, RAG pipeline |
| Payments | Stripe subscriptions |
| DevOps | Docker, GitHub Actions, Vercel + Railway |

## Architecture

```mermaid
flowchart LR
  C[Customer browser<br/>widget.js] <-->|WebSocket| API[NestJS API<br/>REST + Socket.io]
  A[Agent / admin<br/>Next.js dashboard] <-->|HTTPS + WebSocket| API
  API <--> PG[(PostgreSQL<br/>+ pgvector)]
  API <--> R[(Redis<br/>pub/sub, queues, presence)]
  R --> W[Ingestion worker<br/>BullMQ]
  W --> PG
  API --> LLM[LLM + embeddings API]
  W --> LLM
  API <--> S[Stripe]
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Documentation

| Doc | What is in it |
|---|---|
| [PLAN.md](docs/PLAN.md) | 6-week plan, every task with subtasks and acceptance criteria, live status |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, chat flow, RAG, handoff state machine, data model, multi-tenancy, security |
| [PIPELINE.md](docs/PIPELINE.md) | CI/CD pipeline: stages, environments, secrets, deploy and rollback |
| [WORKFLOW.md](docs/WORKFLOW.md) | How each task goes from start to done, branching, commits, PR checklist |
| [PROGRESS.md](docs/PROGRESS.md) | Dated build log |

## Run locally

Requirements: Node 22+, pnpm 10, Docker Desktop, Git (Python 3 only for the progress script).

**Windows, one step:** double-click `scripts\doctor.cmd` (or run it in a terminal). It checks every tool, installs pnpm and
dependencies, starts Postgres + Redis, runs migrations and all checks, and writes `.claude-logs\doctor.log`.

**Manual:**

```bash
cp .env.example .env            # root env for api, worker, db scripts
docker compose up -d            # PostgreSQL 16 + pgvector (host port 5434), Redis 7 (6379)
pnpm install
pnpm db:migrate                 # creates tables, enables pgvector
pnpm db:seed                    # demo tenant Acme Bikes
pnpm dev                        # api :4000, dashboard :3000, widget demo :5173, worker
                                # Bull Board queue UI (dev): http://localhost:4100
```

`pnpm dev` builds `packages/shared`, `packages/db` and `packages/ai` once, then watches the apps. If you edit those packages while it runs, also run `pnpm dev:packages` in a second terminal. If ports 3000 / 4000 / 5173 are stuck or the dashboard shows "Cannot find module" errors, run `scripts\stop-dev.cmd` and start `pnpm dev` again.

| URL | What |
|---|---|
| http://localhost:3000 | Dashboard (shows live system status) |
| http://localhost:4000/health | API health: Postgres, pgvector, Redis |
| http://localhost:5173 | Widget demo host page |

Demo logins (after `pnpm db:seed`): `owner@acme.test`, `admin@acme.test`, `agent@acme.test`, password `Password123!`.

Checks: `pnpm lint && pnpm typecheck && pnpm test` · integration tests (needs Docker running): `pnpm test:integration`

Postgres runs on host port **5434** so it never clashes with a locally installed PostgreSQL on 5432 / 5433.
