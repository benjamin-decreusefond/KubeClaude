# KubeClaude

A web UI that runs Claude Code prompts on a schedule inside Kubernetes.

You define a task once — the instructions, the model, what Claude is allowed to touch,
which MCP servers it can reach — and KubeClaude runs it headless with the Claude CLI,
streams the output back live, and keeps track of what it cost.

The scheduling is built around how a Claude subscription actually works. Besides cron,
a prompt can fire **as soon as a new 5-hour session window opens**, when a new week
opens, or once a configurable share of the token budget is free again. And when a run
is cut off because the quota ran out, it is not thrown away: KubeClaude parks it and
**resumes the same Claude session** once tokens come back, so the model picks up where
it stopped instead of starting over — unless it can tell the task was already finished.

---

## What it does

**Prompts.** A standing task: prompt text, model, permission mode, tool allow/deny
lists, env, MCP connections, a working directory, a `CLAUDE.md`, a timeout.

**Triggers.** Any number per prompt:

| Trigger | Fires |
|---|---|
| `cron` | On a cron schedule, in a timezone you pick. After downtime it catches up **once**, not once per missed slot. |
| `interval` | Every N minutes. |
| `session_reset` | Once per rolling 5-hour window — immediately when none is open, then again the moment it rolls over. This is the "run whenever I have tokens again" trigger. |
| `weekly_reset` | Once per weekly window. |
| `quota_available` | When a configured share of the token budget is free. |

**Runs.** Executed through `claude --print --output-format stream-json`. Every message
is stored, so a run can be watched live over SSE or replayed later. Tokens, cost, turns,
per-model usage and API time all come from the CLI's own report.

**Quota accounting.** Usage lands in 5-hour and weekly windows opened the way Claude
opens them — on the first run after a reset. Set a token budget and the overview turns
into gauges; turn on the guard and KubeClaude holds runs back rather than burning the
last of your allowance.

**Auto-resume.** A run stopped by the usage limit is marked `rate_limited`, not
`failed`. When the quota returns, the scheduler queues a continuation with
`--resume <session-id>` so the model keeps its full context. Human follow-ups work the
same way, and both are threaded into one conversation view.

**Completion detection.** Before resuming, KubeClaude asks whether the task was
*already done* — because resuming finished work wastes exactly the tokens you were
waiting for. Per prompt:

- `marker` (default) — Claude is told to print a sentinel line when it is genuinely
  finished; if that line is in the output, no resume happens. Deterministic, free.
- `judge` — a cheap model reads the transcript and decides.
- `always` / `never` — skip the question entirely.

**MCP connections.** KubeClaude does **not** run MCP servers. It stores how to reach
servers that already run elsewhere and writes them into the `.mcp.json` it hands to
Claude. `${VAR}` placeholders are passed through untouched and expanded from the run's
environment, so tokens live in Kubernetes secrets, not in this database.

---

## Running it

### Configuration

Everything is environment variables; the rest is configured in the UI.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription token. **This is the one that makes the 5-hour and weekly windows meaningful.** |
| `ANTHROPIC_API_KEY` | — | Alternative: API billing. Set one or the other. |
| `ANTHROPIC_BASE_URL` | — | For a gateway or proxy. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |
| `DATA_DIR` | `./data` | SQLite database, per-prompt workspaces, Claude's own config. **Must be persistent.** |
| `MAX_CONCURRENT_RUNS` | `1` | Parallel runs. Raising it spends quota faster. |
| `SCHEDULER_INTERVAL_MS` | `20000` | How often triggers are evaluated. |
| `RUN_RETENTION_DAYS` | `30` | Runs older than this are pruned. `0` keeps everything. |
| `KUBECLAUDE_AUTH_TOKEN` | — | If set, the API and UI require this bearer token. **Set it if the ingress is reachable from the internet** — a KubeClaude with credentials is a Claude that runs commands. |
| `FORWARD_ENV_PREFIXES` | — | Comma-separated prefixes of pod env vars to forward into runs, e.g. `GITHUB_,GIT_`. Nothing is forwarded by default. |
| `CLAUDE_BIN` | `claude` | Path to the CLI. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

Runs get a deliberately narrow environment: `PATH`, `HOME`, `TZ`, the Claude
credentials, the global env from Settings, the prompt's own env, and anything matching
`FORWARD_ENV_PREFIXES`. Nothing else from the pod leaks in.

### Kubernetes

Manifests live in the [`kubernetes`](https://github.com/benjamin-decreusefond/kubernetes)
repo under `kubeclaude/`, as an ArgoCD Application. They cover a Deployment, a Service,
a Traefik Ingress with TLS, a `local` PersistentVolume for `/data`, and an ExternalSecret
that pulls the Claude token out of Vault.

### Locally

```bash
npm install
npm run build
CLAUDE_CODE_OAUTH_TOKEN=… npm start        # http://localhost:8080
```

For development, run the API and the Vite dev server side by side:

```bash
npm run dev          # API on :8080
npm run dev:web      # UI on :5173, proxying /api
```

### Docker

```bash
docker build -t kubeclaude .
docker run -p 8080:8080 -v kubeclaude-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=… kubeclaude
```

The image ships `git`, `gh`, `ripgrep` and `jq` alongside the Claude CLI, so a prompt
can clone a repo, push a branch and merge a pull request without extra setup.

---

## Letting a prompt finish the job

A prompt that has to *change* something needs three things, and it will quietly stall
without any one of them:

1. **A permission mode that allows it.** The default mode denies anything that would
   need approval — correct, since nobody is there to approve, but a task that must write
   will get nowhere. Use `acceptEdits` for file work, or `bypassPermissions` when
   unattended action is the whole point. Narrow it back down with the allow list:
   `Bash(gh pr merge:*)`, `mcp__github__merge_pull_request`.
2. **Credentials, via env.** Put a `GITHUB_TOKEN` in the prompt's env (or the global env
   in Settings) and `gh` will use it. Reference secrets as `${VAR}` in MCP configs so
   they stay in Kubernetes.
3. **Enough room.** Raise the timeout for long jobs. Leave auto-resume on so a quota
   stop is a pause rather than a failure.

Worked example — a prompt that keeps dependency PRs moving:

- **Model** `claude-sonnet-5`
- **Permission mode** `acceptEdits`, **allowed tools** `Bash(gh:*)`
- **Env** `GITHUB_TOKEN=${GITHUB_TOKEN}` (forwarded from a secret)
- **Trigger** `session_reset` — it runs the moment tokens are available again
- **Completion check** `marker` — so a resume only happens if it really was cut short

---

## How it hangs together

```
Browser ──HTTP/SSE──▶ Fastify ──▶ SQLite (prompts, triggers, runs, events, windows)
                          │
                          ├── scheduler   evaluates triggers, sweeps for resumable runs
                          └── queue ──spawn──▶ claude --print --output-format stream-json
                                                 │
                                                 ├── stdout: one JSON message per line
                                                 └── result: session id, tokens, cost
```

One process, one SQLite file, no external dependencies. State lives in `DATA_DIR`;
back that up and you have backed up KubeClaude.

### API

| | |
|---|---|
| `GET /api/dashboard` | Everything the overview shows |
| `GET /api/status`, `/api/usage`, `/api/capabilities`, `/api/models` | Health, quota, what the runs can reach |
| `GET POST /api/prompts`, `PATCH DELETE /api/prompts/:id` | Prompts |
| `POST /api/prompts/:id/run` | Queue a run now |
| `GET POST /api/prompts/:id/triggers`, `PATCH DELETE /api/triggers/:id` | Triggers |
| `GET /api/runs`, `/api/runs/:id`, `/api/runs/:id/events`, `/api/runs/:id/thread` | Runs |
| `POST /api/runs/:id/cancel`, `/resume`, `/follow-up` | Act on a run |
| `GET POST /api/mcp-servers`, `PATCH DELETE /api/mcp-servers/:id` | MCP connections |
| `GET PATCH /api/settings` | Settings |
| `GET /api/stream` | SSE: run created/updated, run output, quota changed |
| `GET /healthz`, `/readyz` | Probes (never require the auth token). `/readyz` reports credential state but stays ready without it, so a missing token does not take the UI offline. |

### Development

```bash
npm run typecheck
npm test          # unit tests plus a full run lifecycle against a stub CLI
npm run build
```

The tests drive the real queue, scheduler and runner against a stub `claude` binary, so
the quota → park → resume → complete path is covered without a token or a network.

---

## A note on the numbers

Anthropic does not publish exact token allowances for subscription plans, so the session
and weekly budgets are yours to set from what you observe. Leave them at zero and the
overview shows running totals instead of gauges, and `quota_available` triggers fall
back to firing once per window — everything still works, you just do not get a
percentage.

## License

MIT — see [LICENSE](LICENSE).
