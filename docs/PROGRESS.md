# SupportPilot - Build Log

A dated record of what was built, how to verify it, and decisions made along the way.
Newest entry first. One entry per completed task (see [WORKFLOW.md](WORKFLOW.md#after-every-task-checklist)).

**Entry template**

```markdown
### YYYY-MM-DD · T0X Task title

- **Built:** what now exists (endpoints, pages, jobs)
- **Files:** main folders / files touched
- **Verify:** commands or clicks that prove it works
- **Decisions:** anything chosen and why (also added to ARCHITECTURE.md if it is architectural)
- **Next:** the next task and any follow-ups
```

<!-- NEW ENTRIES BELOW -->

### 2026-10-16 · T00 Planning and project docs

- **Built:** build plan with 17 tasks (subtasks, acceptance criteria, estimates, dependencies), architecture doc with diagrams, CI/CD workflows (ci, deploy, eval), development workflow, this build log, progress-sync script, and the Word project document.
- **Files:** `docs/`, `.github/`, `scripts/progress.py`, `scripts/build_docx.py`, `README.md`, `../SupportPilot_Project_Document.docx`, `../SupportPilot_Build_Plan.xlsx` (added ID + Completed on columns)
- **Verify:** `python scripts/progress.py status` lists 17 tasks; `python scripts/progress.py sync` regenerates PLAN.md, README, the sheet and the Word doc.
- **Decisions:** pnpm + Turborepo monorepo; NestJS API; Drizzle ORM (first-class pgvector support); Preact + Shadow DOM widget; Vercel + Railway hosting. See ARCHITECTURE.md > Key decisions.
- **Next:** T01 Repo setup (monorepo).
