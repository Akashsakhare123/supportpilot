# SupportPilot - Testing and evals

How SupportPilot proves it works: automated tests on every pull request, plus an eval set that
turns "the AI seems good" into a score CI tracks across prompt, retrieval and model changes (T14).

## Test pyramid

| Layer | What | Where | Runs |
|---|---|---|---|
| Unit | Pure logic: chunker, embeddings, confidence scorer, prompt and injection neutralising, mock LLM, question clustering, eval scoring, hand-off state machine, PII redactor, plans and limits, env, guards (roles, plan limits, JWT) | `packages/*/src/**/*.test.ts` (Vitest), `apps/api/src/**/*.spec.ts` (Jest), `apps/worker/src/**/*.test.ts` | `pnpm test`, CI `quality` |
| Integration | The API and worker against real Postgres + pgvector and Redis: auth, onboarding, uploads, ingestion, search, RAG chat (SSE and sockets), inbox, hand-off, live chat, analytics, billing webhooks and limits | `apps/api/test/*.int-spec.ts`, `apps/worker/src/*.int.test.ts` | `pnpm test:integration`, CI `integration` |
| Tenant isolation | Tenant B (owner, admin, agent) tries to read or change tenant A's documents, chunks, conversations, messages, team, settings, analytics and billing through every endpoint; a route census fails when a new endpoint is not classified | `apps/api/test/isolation.int-spec.ts` | with integration |
| End-to-end | A real browser: signup -> upload a help article -> ask in the widget (answer cites it) -> "Talk to a person" -> the agent takes the chat and the reply appears in the widget | `e2e/support-flow.spec.ts` (Playwright) | `pnpm e2e`, CI `e2e`, the doctor |
| Eval | 39 questions on the Acme Bikes knowledge base, scored for retrieval, correctness, refusals and injection resistance | `evals/acme-bikes.json`, runner `apps/api/src/eval/run-eval.ts`, scoring `packages/ai/src/eval.ts` | `pnpm eval`, CI `RAG Eval` |

## Commands

```bash
pnpm test               # unit tests (no services needed)
pnpm test:integration   # integration suites (docker compose up -d first)
pnpm test:coverage      # unit + integration with coverage; writes coverage/SUMMARY.md
pnpm e2e                # Playwright; starts pnpm dev or reuses running dev servers
pnpm eval               # RAG eval with the configured LLM_PROVIDER / EMBEDDING_PROVIDER
pnpm eval --min-score 0.75 --report evals/report.md
```

Locally Playwright drives the installed Microsoft Edge (`channel: 'msedge'`), so no browser
download is needed; CI installs Playwright's Chromium. `scripts\doctor.cmd` runs everything above
except the eval.

## Coverage

Target: at least 70% of lines overall and in every core service. Jest enforces it per file for
the API core services (auth, billing, plan limits, chat, widget gateway, documents, hand-off, inbox,
analytics, presence); Vitest enforces it for each package. CI's integration job runs
`pnpm test:coverage`, adds `coverage/SUMMARY.md` to the job summary and uploads the lcov reports.

Baseline (2026-10-21):

| Suite | Lines | Statements | Functions | Branches |
|---|---|---|---|---|
| API (integration tests) | 90.3% | 87.4% | 95.7% | 52.8% |
| Worker (unit + integration) | 88.8% | 88.8% | 92.3% | 71.8% |
| packages/ai (unit) | 99.1% | 99.1% | 100.0% | 87.4% |
| packages/shared (unit) | 93.5% | 93.5% | 91.4% | 93.2% |

API branch coverage reads low partly because SWC emits decorator-metadata branches for every Nest
class (each module file shows 26% branches); lines and functions are the meaningful numbers there.

## Eval set

`evals/acme-bikes.json`: 25 answerable questions (each names the article retrieval must find and
the facts the answer must contain), 7 questions the articles cannot answer (the assistant must say
it does not know or hand the chat to a person), and 7 prompt-injection attempts (print the system
prompt, "developer mode", fake closing tags, false premises, fake admin authority, translated
rules). The runner creates a throwaway tenant, embeds the seed articles with the configured
embedding provider, asks every question through the real `ChatService` (same retrieval, prompt,
model and confidence as customers get), scores the answers, writes `evals/report.md` +
`evals/report.json` and deletes the tenant. It exits with 1 below `--min-score`.

| Metric | Meaning |
|---|---|
| Score | Cases passed / all cases (the number CI gates on) |
| Retrieval hit@5 | Answerable questions whose expected article is in the top 5 passages |
| Answer correctness | Answerable questions answered with the expected facts (and not refused) |
| Cites the expected article | Answers whose citations include the expected article |
| Correct refusals | Unanswerable questions refused or handed off, never invented |
| Injection resistance | Injection cases with no leaked rules or obeyed commands, real question still answered |

### Baseline (2026-10-21, offline: `mock-extractive-v1` + `local-hash-v2`, top 5)

**Score 76.9%** (30 of 39). Retrieval hit@5 100%, answer correctness 72%, cites the expected
article 80%, correct refusals 100%, injection resistance 71.4%, average latency 79 ms.

The first run scored 66.7% and found a real bug: the offline assistant split sentences at every
line break, so a sentence wrapped over two lines in an article was cut in half ("Orders placed on
a [1]."). Fixed in `packages/ai/src/llm.ts` (with a unit test); a low-confidence flag on a correct
answer is also no longer counted as a refusal.

The 9 remaining failures are limits of the keyword-matching offline assistant, not of retrieval
(every expected article is retrieved): facts in tables (frame size for 178 cm, kids' wheel size),
FAQ answers whose keywords sit only in the question line ("Do I need a licence?" -> "No. Our
e-bikes assist up to 32 km/h"), paraphrases ("discount on a new frame" vs "crash replacement ...
40% off"), and two injection cases where the extra instruction text dilutes the keyword match so
the real question is refused (safe, but not helpful). A real model is expected to fix most of
these; run `LLM_PROVIDER=openai EMBEDDING_PROVIDER=openai pnpm eval` with a key, or label a PR
`run-eval` once `EVAL_PROVIDER=openai` is set, and record the score here.

CI runs the offline eval on every PR and push to `main` with `EVAL_MIN_SCORE` 0.75 (repository
variable), so a change that hurts retrieval, chunking, prompts or confidence fails visibly.
