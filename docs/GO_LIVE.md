# SupportPilot - Go-live guide (your steps)

Six accounts, about 45-60 minutes, all on free tiers (Cloudflare R2 asks for a card but the
free tier covers this project). Do the parts in order: later parts need values from earlier ones.

**Rule for secrets:** paste keys, tokens and passwords only into the Railway, Vercel and GitHub
dashboards. Never paste them into chat. The only things to send Claude are the four
non-secret items in part 7.

Keep a scratch note (not in the repo) for these values as you go:

| Value | From | Example |
|---|---|---|
| GitHub repo URL | Part 1 | `https://github.com/you/supportpilot` |
| API URL | Part 2 | `https://supportpilot-api-production.up.railway.app` |
| Dashboard URL | Part 4 | `https://supportpilot-dashboard.vercel.app` |
| Widget URL | Part 4 | `https://supportpilot-widget.vercel.app` |

---

## Part 1 - GitHub repository (5 min)

1. Sign in at https://github.com and click **New repository** (the **+** at the top right).
2. Name it `supportpilot`. Public is best for a portfolio; private also works.
3. **Do not** tick "Add a README", ".gitignore" or "license". The repo must be empty.
4. Click **Create repository** and copy its URL into your note.

## Part 2 - Railway: database, Redis, API and worker (15 min)

1. Sign up at https://railway.com with **Login with GitHub**. Pick the free trial or Hobby plan.
2. **New Project > Deploy a template**, search **pgvector**, and deploy the Postgres + pgvector
   template. This is the database. Plain Postgres has no pgvector, so use this template.
3. In the same project click **+ Create > Database > Add Redis**.
4. Click **+ Create > Empty Service** and rename it **`api`** (Settings > Service name).
   Repeat for a second empty service named **`worker`**. The names must be exactly these.
5. **`api` service > Variables > Raw Editor**, paste the block below, then fill in the values:

   ```
   NODE_ENV=production
   API_PORT=4000
   RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile
   DATABASE_URL=${{pgvector.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   JWT_SECRET=<a long random string: run  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">
   APP_URL=<Dashboard URL, fill in after part 4>
   CORS_ORIGINS=<Dashboard URL>,<Widget URL>
   COOKIE_SECURE=true
   TRUST_PROXY=1
   STORAGE_DRIVER=s3
   S3_BUCKET=<from part 3>
   S3_ENDPOINT=<from part 3>
   S3_ACCESS_KEY_ID=<from part 3>
   S3_SECRET_ACCESS_KEY=<from part 3>
   LLM_PROVIDER=mock
   EMBEDDING_PROVIDER=local
   ```

   If the database service has a different name than `pgvector`, use that name inside
   `${{...}}`. The Raw Editor autocompletes it.
6. In the **`api` service > Settings**:
   - **Networking > Generate Domain**, port **4000**. Copy the URL into your note as the API URL.
   - **Deploy > Healthcheck Path**: `/health`.
7. In the **`worker` service > Variables > Raw Editor**:

   ```
   NODE_ENV=production
   RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile
   DATABASE_URL=${{pgvector.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   BULL_BOARD_PORT=0
   STORAGE_DRIVER=s3
   S3_BUCKET=<same as api>
   S3_ENDPOINT=<same as api>
   S3_ACCESS_KEY_ID=<same as api>
   S3_SECRET_ACCESS_KEY=<same as api>
   EMBEDDING_PROVIDER=local
   ```

   The worker needs no domain.
8. **Project Settings > Tokens > Create token** for the `production` environment. You'll paste
   this into GitHub in part 5 as `RAILWAY_TOKEN`.
9. Open the **pgvector** database service > **Variables** and find **`DATABASE_PUBLIC_URL`**.
   GitHub needs this one (part 5) because GitHub's runners are outside Railway.

Real AI answers instead of the free offline assistant are optional and can come later. On
`api` and `worker`, set `LLM_PROVIDER=openai`, `EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY`.

## Part 3 - Cloudflare R2: file storage for uploads (5 min)

1. Sign up at https://dash.cloudflare.com, open **R2 Object Storage** and enable it. It asks for
   a card; the free tier (10 GB) costs nothing.
2. **Create bucket** named `supportpilot-uploads`. Leave it **private** (no public access).
3. **R2 > Manage API tokens > Create API token**:
   - permission **Object Read & Write**
   - scope: **only the bucket** `supportpilot-uploads`
4. Copy the values shown into the Railway variables from part 2 (`api` and `worker`):
   - **Access Key ID** -> `S3_ACCESS_KEY_ID`
   - **Secret Access Key** -> `S3_SECRET_ACCESS_KEY`
   - **jurisdiction endpoint** `https://<account-id>.r2.cloudflarestorage.com` -> `S3_ENDPOINT`
   - `supportpilot-uploads` -> `S3_BUCKET`

## Part 4 - Vercel: dashboard and widget (10 min)

Do part 7 step 1 first: Vercel can only import the repo once the code is on GitHub. Tell
Claude the repo URL and wait for the push.

1. Sign up at https://vercel.com with **Continue with GitHub** (Hobby plan).
2. **Add New > Project**, import `supportpilot`:
   - **Project name:** `supportpilot-dashboard`
   - **Root Directory:** `apps/dashboard` (framework: Next.js)
   - **Environment Variables:**

     ```
     API_INTERNAL_URL=<API URL>
     NEXT_PUBLIC_API_URL=<API URL>
     NEXT_PUBLIC_WIDGET_URL=<Widget URL, i.e. https://supportpilot-widget.vercel.app>
     ```

   - Click **Deploy**. The first build may run once from Vercel. Copy the domain into your note
     as the Dashboard URL.
3. **Add New > Project** again, same repo:
   - **Project name:** `supportpilot-widget`
   - **Root Directory:** `apps/widget` (framework: **Other**)
   - **Environment Variables:** `VITE_API_URL=<API URL>`
   - Click **Deploy**, then copy the domain as the Widget URL.
4. Go back to Railway `api` and fill in `APP_URL` and `CORS_ORIGINS` with the real URLs.
5. Collect the IDs for GitHub:
   - **Vercel token:** Account Settings > Tokens > Create (scope your team).
   - **Org id:** Team Settings > General > **Team ID**.
   - **Project ids:** each project > Settings > General > **Project ID** (dashboard and widget).

Production deploys come from GitHub Actions (the repo's `vercel.json` turns off Vercel's own
deploys for `main`). Pull requests still get Vercel preview links.

## Part 5 - GitHub settings (10 min)

In the repo: **Settings > Environments > New environment** named **`production`**. Add these
under **Environment secrets**:

| Secret | Value |
|---|---|
| `DATABASE_URL` | Railway pgvector **DATABASE_PUBLIC_URL** (part 2 step 9) |
| `RAILWAY_TOKEN` | Railway project token (part 2 step 8) |
| `VERCEL_TOKEN` | Vercel token |
| `VERCEL_ORG_ID` | Vercel Team ID |
| `VERCEL_DASHBOARD_PROJECT_ID` | dashboard Project ID |
| `VERCEL_WIDGET_PROJECT_ID` | widget Project ID |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | same as part 3 |

Then add these under **Settings > Secrets and variables > Actions > Variables** (repository
variables):

| Variable | Value |
|---|---|
| `DEPLOY_ENABLED` | `true` |
| `API_URL` | API URL |
| `APP_URL` | Dashboard URL |
| `WIDGET_URL` | Widget URL |
| `SEED_DEMO` | `true` (creates the Acme Bikes demo workspace) |
| `DEMO_ALLOWED_DOMAINS` | the widget host without https, e.g. `supportpilot-widget.vercel.app` |

**Settings > Branches > Add rule** for `main`: require a pull request and the status checks
`docs`, `quality`, `integration`, `build`. You can do this after the first deploy.

## Part 6 - Optional monitoring (10 min)

- **Sentry:** at https://sentry.io create a **Node.js** project and copy its **DSN** to Railway
  `SENTRY_DSN` on `api` and `worker`.
- **Uptime:** at https://betterstack.com (or UptimeRobot), add a monitor on `<API URL>/health`
  checked every minute, with email alerts.
- **Stripe test mode** (billing page): follow "Stripe billing" in the README with the webhook
  endpoint `<API URL>/billing/webhook` instead of the Stripe CLI.

## Part 7 - Hand-off to Claude and the first deploy

1. **Send Claude the GitHub repo URL.** Claude adds it as `origin` and pushes `main`. The first
   push opens a GitHub sign-in window on your PC; approve it.
2. Do parts 4 and 5.
3. **Send Claude the API, Dashboard and Widget URLs.** These aren't secrets. Claude checks the
   setup against them.
4. On GitHub: **Actions > Deploy > Run workflow > main**. Claude can watch it and fix anything
   that fails. From then on, every merge to `main` deploys itself.
5. Check that it works:
   - the dashboard login page opens;
   - `owner@acme.test` / `Password123!` signs in to the demo workspace;
   - `<Widget URL>` shows the demo page, and the chat bubble answers "How long is the frame warranty?"

## Your checklist

- [ ] 1. GitHub: create an empty repo, send Claude the URL
- [ ] 2. Railway: pgvector + Redis + `api` + `worker`, variables, API domain, project token
- [ ] 3. Cloudflare R2: bucket + API token, values into Railway
- [ ] 4. Vercel: `supportpilot-dashboard` and `supportpilot-widget` projects, token and IDs
- [ ] 5. GitHub: `production` environment secrets + repository variables
- [ ] 6. Optional: Sentry DSN, uptime monitor, Stripe test webhook
- [ ] 7. Send Claude the three URLs, run **Deploy** once, try the demo
