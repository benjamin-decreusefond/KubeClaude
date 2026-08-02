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

**Chat.** Talk to Claude directly, with the same access a scheduled prompt gets. Each
message resumes the same session, so it keeps its context and you can steer it as it
works — ask it to look at something, watch what it finds, tell it what to do next. When
a conversation does what you want, save it as a prompt and put it on a schedule.

The composer has two completions, both plain text insertions — nothing is a command
and nothing is interpreted. `@` lists files in the conversation's working directory, so
you can point at one without going to look up its path. `/`, at the start of a message,
lists the prompts you have saved and drops the chosen one's text in for you to edit
before sending. Arrow keys to move, Enter or Tab to take one, Escape to dismiss.

**Prompts.** A standing task: prompt text, model, permission mode, tool allow/deny
lists, env, MCP connections, a working directory, a `CLAUDE.md`, a timeout.

**A repository to work in.** A prompt, a chat or a goal can name one. KubeClaude clones
it into the working directory before the first run, and before every run after that
fetches and resets it onto the requested branch — so a run starts on a clean checkout of
the right commit rather than on whatever the last one left behind. See
[Working in a repository](#working-in-a-repository).

**Authentication.** It asks you to set a password the first time you open it, and after
that you choose how to sign in: a login page, HTTP basic, a trusted reverse proxy, or
nothing at all — plus the "skip it on the local network" switch Sonarr and Radarr have.
An API key covers scripts in every one of those modes. See
[Who can reach it](#who-can-reach-it).

**Triggers.** Any number per prompt:

| Trigger | Fires |
|---|---|
| `cron` | On a cron schedule, in a timezone you pick. After downtime it catches up **once**, not once per missed slot. |
| `interval` | Every N minutes. |
| `session_reset` | Once per rolling 5-hour window — immediately when none is open, then again the moment it rolls over. This is the "run whenever I have tokens again" trigger. |
| `weekly_reset` | Once per weekly window. |
| `quota_available` | When a configured share of the token budget is free. |

**Goals.** A session that does not stop at one run. Where a prompt answers "run this
now", a goal answers "keep working on this until it is true": you give it a mission and
a list of objectives, and it iterates. Each iteration resumes the same Claude session,
is told which objectives are still open and what earlier iterations achieved, does one
meaningful unit of work, and ends with a short report. That report is parsed — no second
model call — objectives it closed are ticked off, and the next iteration is queued once
the cadence has passed. It stops when everything is ticked, when it hits an iteration
limit, or when you pause it. See [Goals](#goals-that-keep-going).

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

**Environment briefing.** A scheduled run starts with no history and nobody to ask, so
what it needs to know about the platform is stated up front: that it has a cluster to
inspect, a GitHub token to push and merge with, and that changes reach the cluster
through git rather than `kubectl`. One piece of standing text in Settings, prepended to
every run's system prompt. See [Telling a run where it is](#telling-a-run-where-it-is).

**MCP connections.** KubeClaude does **not** run MCP servers. It stores how to reach
servers that already run elsewhere and writes them into the `.mcp.json` it hands to
Claude. `${VAR}` placeholders are passed through untouched and expanded from the run's
environment, so tokens live in Kubernetes secrets, not in this database.

Reach for MCP when a service has no CLI. **GitHub and Kubernetes already have one** —
`gh` and `kubectl` ship in the image and authenticate from the environment and the pod's
ServiceAccount. Brokering those same APIs through an MCP server adds a network hop, a
second auth system, and a component that can be down, for no capability you did not
already have.

---

## Running it

### Configuration

Everything is environment variables; the rest is configured in the UI.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription token. **This is the one that makes the 5-hour and weekly windows meaningful.** |
| `ANTHROPIC_API_KEY` | — | Alternative: per-token API billing. Ignored if the OAuth token is also set. |
| `ANTHROPIC_BASE_URL` | — | For a gateway or proxy. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |
| `DATA_DIR` | `./data` | SQLite database, per-prompt workspaces, Claude's own config. **Must be persistent.** |
| `MAX_CONCURRENT_RUNS` | `1` | Parallel runs. Raising it spends quota faster. |
| `SCHEDULER_INTERVAL_MS` | `20000` | How often triggers are evaluated. |
| `RUN_RETENTION_DAYS` | `30` | Runs older than this are pruned. `0` keeps everything. |
| `MAX_EVENT_BYTES` | `65536` | Ceiling on one stored line of run output. Over it, the long strings inside the message are cut and marked — a tool result that read a large file keeps its shape, not its megabytes. |
| `DB_BACKUPS_KEPT` | `5` | Copies of the database kept in `DATA_DIR/backups`; one is taken before every migration. |
| `MAX_STORED_ERRORS` | `200` | Distinct faults kept in the error feed. |
| `KUBECLAUDE_AUTH_TOKEN` | — | A static credential accepted as `Authorization: Bearer` or `X-Api-Key`, on top of whatever login method is configured. Optional now that the app has its own accounts — see [Who can reach it](#who-can-reach-it). |
| `AUTH_METHOD` | — | Pin the login method to `none`, `forms`, `basic` or `external`. Set it and the UI shows the choice as locked, so an instance deliberately placed behind an SSO proxy cannot have that turned off from inside the app. |
| `FORWARD_ENV_PREFIXES` | — | Comma-separated prefixes of pod env vars to forward into runs, e.g. `GITHUB_,GIT_`. Nothing is forwarded by default. |
| `EXPOSE_KUBERNETES` | `true` | Forward `KUBERNETES_SERVICE_HOST`/`PORT` so `kubectl` can reach the API server as the pod's ServiceAccount. Set `false` to deny cluster access outright. |
| `GITHUB_TOKEN` | — | Forwarded into runs (as both `GITHUB_TOKEN` and `GH_TOKEN`) so `git` push over HTTPS and `gh` are authenticated. |
| `EXPOSE_GITHUB_TOKEN` | `true` | Set `false` to keep the token for KubeClaude and withhold it from runs. |
| `CLAUDE_BIN` | `claude` | Path to the CLI. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

Runs get a deliberately narrow environment: `PATH`, `HOME`, `TZ`, the Claude
credentials, the global env from Settings, the prompt's own env, the Kubernetes service
host and port when `EXPOSE_KUBERNETES` is on, and anything matching
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

The image ships `git`, `gh`, `kubectl`, `ripgrep` and `jq` alongside the Claude CLI, so a
prompt can clone a repo, push a branch, merge a pull request, and then check what the
cluster made of it.

CI publishes to Docker Hub as `paganim/kubeclaude`, tagged `latest` and the commit SHA,
on every push to `main`. Pull requests build the image but do not push it. Two repository
secrets are needed:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Your Docker Hub account name. |
| `DOCKERHUB_TOKEN` | An access token from [Docker Hub → Account Settings → Personal access tokens](https://app.docker.com/settings/personal-access-tokens), scoped **Read & Write**. Not your password. |

To publish under a different namespace, set a `DOCKERHUB_NAMESPACE` repository *variable*
— the workflow falls back to `paganim` when it is unset.

---

## Letting a prompt finish the job

A prompt that has to *change* something needs three things, and it will quietly stall
without any one of them:

1. **A permission mode that allows it.** The default mode denies anything that would
   need approval — correct, since nobody is there to approve, but a task that must write
   will get nowhere. Use `acceptEdits` for file work, `auto` to let the CLI's own
   classifier judge each call (ordinary work runs, force pushes and production deploys
   are refused), or `bypassPermissions` when unattended action is the whole point.
   Narrow it back down with the allow list: `Bash(gh pr merge:*)`,
   `mcp__github__merge_pull_request`.
2. **Credentials, via env.** Put a `GITHUB_TOKEN` in the prompt's env (or the global env
   in Settings) and `gh` will use it. Reference secrets as `${VAR}` in MCP configs so
   they stay in Kubernetes.
3. **Enough room.** Raise the timeout for long jobs. Leave auto-resume on so a quota
   stop is a pause rather than a failure.

### Telling a run where it is

Capability is not the same as knowing you have it. A run can hold a GitHub token and a
kubeconfig and still do nothing useful, because nothing told it there is a cluster
worth looking at or that pushing to git is how a deploy happens. Three places carry
that knowledge, and picking the right one matters:

| Put it in | When it applies | Good for |
|---|---|---|
| **Environment briefing** (Settings) | Every run, always | "You are in a Kubernetes cluster. ArgoCD syncs from git and `selfHeal` reverts anything not in it. A republished `:latest` needs `rollout restart`. Verify with `rollout status` before claiming success." |
| **Appended system prompt** (per prompt) | Every run of one prompt | "Only ever touch the `media/` directory." "Never merge a PR that changes CI." |
| **The prompt text** | The task itself | "Review the open PRs and merge the green dependency ones." |

The briefing is the one that answers *"how do I tell it that it has a cluster?"*. It
ships with a default covering the whole loop — what is installed, what it may and may
not touch, the three shapes a deploy takes, which `kubectl` commands actually confirm a
rollout, and that a green push is not a deploy. Edit it in Settings; it is your cluster,
and it should say so.

Two things worth stating explicitly, because a model that does not know them will fight
your platform:

- **Git is the source of truth.** With `selfHeal: true` and `prune: true`, anything
  created in-cluster that is not also in git gets reverted or deleted on the next sync.
  A run that edits a live Deployment may report success in the window before that
  happens.
- **A republished tag is invisible to ArgoCD.** When CI pushes `:latest` again, the
  manifest is byte-identical, so there is no drift to sync and the old pods keep
  running. That is the case where `kubectl rollout restart` is the right answer rather
  than a workaround — and the reason the ServiceAccount can do it.

Worked example — a prompt that keeps dependency PRs moving:

- **Model** `claude-sonnet-5`
- **Permission mode** `acceptEdits`, **allowed tools** `Bash(gh:*)`
- **Env** `GITHUB_TOKEN=${GITHUB_TOKEN}` (forwarded from a secret)
- **Trigger** `session_reset` — it runs the moment tokens are available again
- **Completion check** `marker` — so a resume only happens if it really was cut short

The image ships `git`, `gh`, `kubectl`, `ripgrep` and `jq` next to the Claude CLI, so a
prompt can clone, branch, push, merge, deploy the result and check that it came up.

`kubectl` authenticates as the pod's ServiceAccount. The manifests in the companion repo
grant read access to everything except Secrets, plus enough write access to take a change
all the way to running: create ArgoCD Applications, and `rollout restart` a Deployment.
Most changes still go through git — but two things git alone cannot do are registering a
new app with ArgoCD, and redeploying when CI republishes a moving tag like `:latest` and
the manifest is therefore unchanged.

Set `EXPOSE_KUBERNETES=false` to withhold cluster access entirely: `kubectl` builds its
in-cluster config from `KUBERNETES_SERVICE_HOST`/`PORT`, so not forwarding those is what
actually turns it off.

---

## Working in a repository

Give a prompt, a chat or a goal a repository URL and a branch, and the checkout stops
being the prompt's problem.

**Before every run**, KubeClaude clones it into the working directory if it is not there,
then fetches and `reset --hard`s onto the branch. That is deliberate rather than a pull:
the workspace is a scratch copy of the remote, and a run that was killed mid-rebase or
left a conflicted merge must not poison the next one. Anything worth keeping was pushed.
A tag or a commit SHA is checked out as given. If the clone or the checkout fails, the
run **fails** — running against an empty or stale directory would look like success and
be worse than stopping.

**Committing and pushing need no setup in the prompt.** Every run gets a gitconfig with
a committer identity (Settings → Git), `init.defaultBranch=main`, `safe.directory`, and a
credential helper for github.com. The helper is a shell function that reads
`GITHUB_TOKEN` from the environment when git asks — nothing secret is written to disk,
and rotating the token needs no change here. `gh` sees the same token, so
`gh pr create` works in the same run that pushed the branch.

So a prompt can be about the change rather than about the plumbing:

> On `main`, run the test suite. If anything fails, fix it on a branch, push, and open a
> pull request describing what was wrong.

The remote has to be an `https://` or `git@host:owner/repo` URL. A local path is refused:
that string goes to `git clone`, and a prompt naming a path on the data volume is either
a mistake or an attempt to read something else on it.

---

## Who can reach it

A KubeClaude with credentials is a Claude that runs commands — on your cluster, in your
repositories, with your tokens. So the first time you open it, it asks you to set a
password before it will show you anything.

Setup happens in the browser: username, password, and how you want to sign in from then
on. It hands you an **API key** once, and that key keeps working whatever you change
later — automation does not break when you change how people sign in. The password and
the key are stored scrypt-hashed; sessions live in the database, so signing out, changing
the password or switching method revokes them for real.

**Login methods**, changed at any time in Settings → Security:

| Method | What it does |
|---|---|
| **Forms** | A login page and a session cookie. The default, and what you want unless something in front already authenticates. |
| **Basic** | The browser's own credentials dialog, sent on every request. No login page, and no signing out short of closing the browser. |
| **External** | A reverse proxy in front — oauth2-proxy, Authelia, Cloudflare Access, an ingress with SSO — has already authenticated the request. KubeClaude reads the user name from a header (`X-Forwarded-User` by default; empty means trust the proxy unconditionally). If the header stops arriving the request is refused, because a proxy that stopped sending it is a misconfiguration rather than an invitation. |
| **None** | Nobody is asked anything. Only sane behind a VPN or a proxy that gates access for you. |

**Skip authentication on the local network** is the other switch, the same one Sonarr and
Radarr offer: requests from `127.0.0.1`, `10.`, `172.16–31.`, `192.168.` and IPv6 ULA get
in without signing in. Convenient at home, and wrong the moment that port is reachable
from outside — note that behind a reverse proxy *every* request looks local unless the
proxy sets the forwarded headers.

A few details worth knowing:

- **Upgrading an instance that used `KUBECLAUDE_AUTH_TOKEN`** does not open a window: the
  setup screen requires that token before it will set a password, so whoever gets there
  first cannot claim the instance. It asks for it up front — the field is on the form from
  the start, not behind a disclosure you have to find after being refused — and the value
  is the same `KUBECLAUDE_AUTH_TOKEN` the deployment runs with.
- **`AUTH_METHOD` in the environment wins**, and the UI shows the method as locked. That
  is for the GitOps case: the cluster decides this instance sits behind an SSO proxy, and
  nothing inside the app should be able to turn that off.
- **Failed logins are rate-limited** per address. scrypt makes each attempt expensive,
  which is exactly why guessing has to be capped — otherwise it is a way to burn the CPU
  the runs need.
- **The API key and the static token work in every mode**, including `external`. That is
  how a script talks to an instance whose humans sign in through SSO.

---

## Goals that keep going

A prompt runs and finishes. A goal keeps working: it is a single Claude session put on a
loop, with a checklist it is trying to close.

You give it:

- **A mission** — the standing brief every iteration reads. What matters, what "good"
  looks like, what it must not touch.
- **Objectives** — one line each, the things that get ticked off. Leave the list empty
  and the goal is open-ended: it works from the mission and keeps improving.
- **A cadence** — how long to wait after one iteration before starting the next.
- Optionally an **iteration limit**, so an unattended goal cannot run forever.

Each iteration is handed the mission, the objectives with their current state, and a
digest of what the last few iterations did and what they said to do next. It is asked to
do *one* meaningful unit of work — carried through to something real and verified — and
to end with a report:

```
PROGRESS: Added a backoff to the client and covered it with a test.
DONE: o1, o3
NEXT: Wire the same backoff into the worker.
```

That report is read mechanically, which is what keeps the loop cheap: no second model
call in the normal case, and the objective ids are checked against the list, so an
iteration cannot tick a box that was never there. If an iteration forgets to write a
report, the entry says so and the loop carries on — set a **review model** on the goal
and a cheap model reads the transcript instead.

How it ends:

| Situation | What happens |
|---|---|
| Every objective ticked | `achieved`, unless you turned off "stop when achieved" — then it keeps iterating and improving. |
| Iteration limit reached | `abandoned`. Resuming lifts the limit. |
| Three failed or timed-out iterations in a row | Paused automatically. Something is wrong with the setup, and looping would spend the budget reproducing it. A restart of KubeClaude itself does **not** count — a deploy or a node drain is not the task failing, and a goal that ships anything would otherwise stop itself after three of its own deployments. |
| Quota ran out mid-iteration | Nothing special: the run parks as `rate_limited` and auto-resume finishes that iteration before the loop moves on. |
| You pause it | The loop leaves it alone, and any iteration in flight is cancelled. Nothing reads an iteration's report while it is paused, so "Iterate now" is refused until you resume it. |

A goal owns its own prompt — same runner, same quota accounting, same live output — so
every iteration is a normal run you can open, watch and replay. It does not appear in the
prompt list; it is configured from the goal instead.

Worked example — keeping a namespace healthy:

- **Mission** "Keep the media namespace healthy: no CrashLoopBackOff, no pending PVCs,
  requests that match real usage. Change one thing at a time and verify it. Never delete
  a StatefulSet."
- **Objectives** "Every pod is running and ready", "No PVC pending over an hour",
  "Requests within 20% of observed usage"
- **Cadence** 60 minutes, **permission mode** `bypassPermissions`, **model**
  `claude-sonnet-5`
- **Stop when achieved** off — health is not a thing you finish

---

## How it hangs together

```
Browser ──HTTP/SSE──▶ Fastify ──▶ SQLite (prompts, triggers, goals, runs, events, windows)
                          │
                          ├── scheduler   evaluates triggers, sweeps for resumable runs
                          │               and advances goals: review, tick, queue next
                          └── queue ──spawn──▶ claude --print --output-format stream-json
                                                 │
                                                 ├── stdout: one JSON message per line
                                                 └── result: session id, tokens, cost
```

One process, one SQLite file, no external dependencies. State lives in `DATA_DIR`;
back that up and you have backed up KubeClaude.

### When something goes wrong

Two things exist because a self-running instance has nobody watching its logs.

**The error feed** — the **Errors** page, `/api/errors`. A request that threw, a
rejection nothing handled, a run that could not be started, and a page of the UI that
failed to render: all of them land in one list, with a stack. Identical faults are
counted rather than repeated, so a poll that has been failing every fifteen seconds
since Tuesday is one line saying so. The sidebar shows the count. Nothing here goes
anywhere else — it is a local list, not telemetry.

**A copy before every migration** — a migration runs at startup, and one that succeeds
but leaves the app unable to start is the single failure it cannot repair from the
inside, because the thing that would fix it is the thing that is down. So before any
migration is applied to a database that already has a schema, `VACUUM INTO` writes a
consistent copy to `DATA_DIR/backups`, and the last few are kept. Restoring is
deliberate — stop the pod, put the copy over `kubeclaude.db`, start it again — and the
files are listed at the bottom of the Errors page.

### API

| | |
|---|---|
| `GET /api/dashboard` | Everything the overview shows |
| `GET /api/status`, `/api/usage`, `/api/capabilities`, `/api/models` | Health, quota, what the runs can reach |
| `GET POST /api/prompts`, `PATCH DELETE /api/prompts/:id` | Prompts |
| `POST /api/prompts/:id/run` | Queue a run now |
| `GET /api/capabilities` | Includes the git identity and whether a GitHub token is forwarded — never the token |
| `GET /api/prompts/:id/files` | Paths under a prompt's working directory, for the composer's `@` completion |
| `GET POST /api/prompts/:id/triggers`, `PATCH DELETE /api/triggers/:id` | Triggers |
| `GET POST /api/chats`, `GET PATCH DELETE /api/chats/:id` | Conversations |
| `POST /api/chats/:id/messages`, `/stop`, `/promote` | Reply, interrupt, save as a prompt |
| `GET POST /api/goals`, `GET PATCH DELETE /api/goals/:id` | Goals and their objectives |
| `POST /api/goals/:id/start`, `/pause`, `/iterate` | Resume the loop, hold it, run one iteration now |
| `GET /api/goals/:id/iterations` | The progress log |
| `GET /api/runs`, `/api/runs/:id`, `/api/runs/:id/events`, `/api/runs/:id/thread` | Runs |
| `POST /api/runs/:id/cancel`, `/resume`, `/follow-up` | Act on a run |
| `GET POST /api/mcp-servers`, `PATCH DELETE /api/mcp-servers/:id` | MCP connections |
| `GET PATCH /api/settings`, `GET /api/settings/defaults` | Settings, and the shipped defaults |
| `GET POST DELETE /api/errors`, `DELETE /api/errors/:id` | The error feed: read it, file a browser fault, dismiss one, clear the list |
| `GET /api/backups` | The copies taken before each migration |
| `GET /api/stream` | SSE: run created/updated, run output, quota changed |
| `GET /api/auth/state`, `POST /api/auth/setup`, `/login`, `/logout` | Public: what the login screen needs, and the three things it can do |
| `GET PATCH /api/auth/config` | Login method, local bypass, proxy header, username, session lifetime |
| `POST /api/auth/password`, `/api-key`, `/sessions/revoke` | Change the password, mint a new API key, sign every browser out |
| `GET /healthz`, `/readyz` | Probes (never authenticated). `/readyz` reports credential state but stays ready without it, so a missing token does not take the UI offline. |

### Development

```bash
npm run verify    # lint + typecheck + tests + build: the single gate
npm run e2e       # the browser pass, after a build
```

Or one layer at a time:

```bash
npm run lint                 # eslint, type-aware, zero warnings tolerated
npm run lint:fix             # the mechanical half of it
npm run typecheck            # server, web and the e2e specs
npm run test:server          # queue, scheduler, stores, and the HTTP API
npm run test:web             # components, in jsdom
npm run build
```

**Linting** is type-aware, which is the point: it is what catches a floating
promise in the queue — a run that silently never finishes — or a value off the
CLI's JSON stream rendered as `[object Object]`. It has no opinion about quotes
or line width; there is no formatter here, and the rules are chosen for what
they catch rather than for how they look.

**Three layers, and what each one is for.**

| Layer | What it proves | Cost |
|---|---|---|
| `server/test/*.test.ts` | The queue, scheduler, goal loop and auth guard behave — driven against a stub `claude` binary, so the quota → park → resume → complete path is covered without a token or a network. `api.test.ts` goes through the real HTTP stack with `app.inject()`, so routes, schemas and the auth hook are covered too | ~30s |
| `web/src/**/*.test.tsx` | Components render and their forms submit, and a page that throws is caught, reported and recoverable. Typechecking cannot see a screen that throws on an empty instance | ~2s |
| `e2e/tests` | The built server, the built SPA and a real Chromium. Every page renders; a prompt is written, scheduled with a cron trigger, run, and read back; a goal is set, its objectives ticked, its progress log filled, paused and deleted; a chat is held; an MCP connection is stored and previewed; settings and every login method are exercised; a fault is filed, read and dismissed on the Errors page; signing out and back in works. Each test also fails on an uncaught page error, not just on its assertions | ~30s |

The e2e run starts its own server on a throwaway database with the stub CLI and no
credentials, so a full pass touches no cluster and spends no quota. That is deliberate:
it has to be safe to run on every pull request, and from inside a KubeClaude that is
working on this repository.

**Which build am I running?** `/api/status` reports `version`, shown in the sidebar. CI
stamps it with `main-<sha>`; a release tag stamps the version. On `dev` you are looking
at a local build.

### Releasing

`latest` follows the tip of `main` — CI publishes it on every merge, once the tests and
the browser pass are green. A deployment that should only move when you say so pins a
version instead:

```bash
git tag v1.4.2 && git push origin v1.4.2
```

That runs the whole gate again, then publishes `1.4.2`, `1.4` and `1`, and opens a
GitHub release. A pre-release (`v1.5.0-rc.1`) publishes only its exact version, so `:1`
never starts pointing at a release candidate.

---

## Authenticating to Claude

The CLI needs credentials in its environment; KubeClaude passes exactly one set through
to every run and never writes them to disk. Pick whichever matches how you pay for
Claude:

| How you pay | Variable | How to get it |
|---|---|---|
| Pro / Max subscription | `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` on a machine where you are already logged in; it prints a long-lived token (`sk-ant-oat…`). |
| API credit (per token) | `ANTHROPIC_API_KEY` | Create a key in the [Claude Console](https://console.anthropic.com/settings/keys). |
| A gateway in front of Claude | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | Whatever your proxy issues. |

These are not interchangeable, and the difference is money. A subscription token
spends your plan's allowance — the same bucket as the desktop app and the terminal, no
per-token charge. An API key bills Console credit at published per-token rates and has no
allowance to run out of.

Because that distinction matters, KubeClaude forwards **exactly one** credential to a
run rather than letting the CLI choose: a gateway if `ANTHROPIC_BASE_URL` is set,
otherwise the subscription token, otherwise the API key. Set both a token and a key and
the key is ignored — Settings says so out loud rather than leaving you to wonder which
one is paying, and `/api/status` reports the resolved mode as `billingMode`.

The subscription token is the one that makes the rest of this app mean anything: 5-hour
and weekly windows, `session_reset` / `weekly_reset` / `quota_available` triggers and
auto-resume all exist because a subscription has windows to run out of. An API key bills
per token and never rate-limits you that way, so those triggers degrade to plain
schedules.

Interactive `claude login` is not an option in a pod — there is no browser to redirect
to. `claude setup-token` is the headless equivalent, and it is what the Kubernetes
manifests expect (`claude_code_oauth_token` in the ExternalSecret). `/api/status`
reports which credential is in play, and the UI shows a banner when none is.

## A note on the numbers

Anthropic publishes per-token API pricing, but not the token allowance behind a Pro or
Max subscription — the figures circulating in the community (roughly 44k per 5-hour
window on Pro, 88k on Max 5x, 220k on Max 20x) are observed estimates, not documented
limits, and Anthropic has adjusted them before. Treat them as a starting point, then
calibrate against what your own overview shows.

Leave the budgets at zero and the overview shows running totals instead of gauges, and
`quota_available` triggers fall back to firing once per window — everything still works,
you just do not get a percentage.

**What counts as spend** matters more than the number you type. A run re-reads its whole
cached prefix on every turn, so `cache_read_input_tokens` dominates the raw total while
costing a tenth of a fresh input token. Summing all four counters at face value would put
a single real run at several times a 44k budget. The **budget basis** setting decides how
the raw counters become spend:

| Basis | Counts | Use when |
|---|---|---|
| `weighted` (default) | input + output + 1.25 × cache writes + 0.1 × cache reads | You want the gauge to track what you are actually being charged for. |
| `input_output` | input + output only | You want to ignore caching entirely. |
| `total` | everything at face value | You are budgeting raw throughput, not cost. |

Run history keeps the raw counters either way; only the gauge and the quota guard read
the basis.

## Choosing how a run runs

Four CLI controls sit next to the model, per prompt, with a global default behind each
of the first two:

**Fallback models.** `--fallback-model`, a comma-separated chain. When the chosen model
is overloaded or unavailable the CLI moves down the list instead of failing, and retries
the primary at the start of each turn. A scheduled run has nobody to retry it by hand,
so `opus` with `sonnet,haiku` behind it is the difference between the work happening on
a smaller model and not happening at all. Set it globally in Settings — capacity is a
property of the account, not of one task — and override it on the prompts that care.

**Effort.** `--effort`, one of `low`, `medium`, `high`, `xhigh`, `max`. How hard the
model works per turn, and roughly what it costs. Left empty the CLI decides, which is
not the same as choosing a level: a prompt that says nothing follows whatever the global
default says, and a prompt that pins one always wins.

**A cost ceiling.** `--max-budget-usd`, per run. The CLI stops itself once a run has
spent that much and still reports what it did, which is gentler than the global
`runTokenCap` — that one kills the process from outside. Use the dollar ceiling on a
prompt whose cost you can name, and the token ceiling as the blunt instrument behind
everything.

**Additional directories.** `--add-dir`, absolute paths. The working directory is
already writable; these are the extra ones. This is what lets a single prompt work
across two checkouts — read the manifests in one repository, change the code in another
— instead of needing a prompt per directory.

None of the four is passed to the CLI unless something asked for it, so a prompt that
leaves them alone invokes exactly the command it did before.

## Choosing what a run is made of

Four more, on the prompt's Advanced tab, about what the run *has* rather than what it
spends:

**Built-in tools.** `--tools`. Which tools the model is told exist at all — distinct
from the allow list, which decides what may run without asking. Every tool carries its
schema in the system prompt of *every* request, so a prompt that only ever reads files
pays for WebFetch on every turn until you take it away. Three states, and the difference
matters: leave it alone for the CLI's full set, list the ones to keep, or hand it none.

**Custom subagents.** `--agents`, a JSON object of `{name: {description, prompt}}`. The
run can delegate to them the way it would to a built-in agent, without any of it having
to live in a repository.

**A replacement system prompt.** `--system-prompt`, as opposed to the appended one. It
replaces Claude Code's own — everything it says about being an agent with tools
included — so it is the flag to leave alone unless replacing exactly that is the point.
The environment briefing and the completion marker are still appended after it, so
KubeClaude's own context survives either way.

**Which settings files are read.** `--setting-sources`. Left alone the CLI reads the
user, project and local settings, and the *project* one belongs to whatever repository
the run just cloned — its hooks, its permissions, its MCP servers. A prompt that works
in somebody else's repository can narrow this to `user`, or to `none`, and be handed
only what KubeClaude gives it.

## Spending less

KubeClaude does not control tokenization, prompt caching or compaction — the CLI owns
all three. What a wrapper controls is **how much conversation happens** and **what sits
in the cached prefix**, and that is where the money is. Four levers, most useful first.

**Cap the turns.** Every turn re-sends the whole conversation, so spend grows
superlinearly with turn count and a run that goes in circles can eat a window by itself.
`defaultMaxTurns` (120 out of the box) applies to any prompt that does not pin its own.
A prompt setting `0` opts out deliberately; leaving it empty inherits the default.

The default is deliberately not tight. A run that hits the cap stops mid-task with its
working tree half-edited, which costs the whole run and produces nothing — thirty turns
is enough to look something up and report, and nowhere near enough to change code and
open a pull request. The per-run token ceiling below is the budget guard; the turn cap
is there to stop a genuinely stuck loop. When a run does hit it, the run says so and can
be resumed: the session is still there and picks up where it stopped.

**Set a per-run ceiling.** `runTokenCap` kills a run on the turn it crosses the limit,
weighed by the same `budgetBasis` as the gauges so the number means one thing everywhere.
Spend up to that point is still charged to the window — a killed run reports the usage it
streamed, not nothing — and the run is never auto-resumed, because retrying would spend
the ceiling again for the same result. Off by default: it stops a run mid-task, so it is
a deliberate choice rather than a surprise.

**Shrink the tool list.** Every tool Claude can reach carries its schema in the system
prompt of *every request*, so an unused WebFetch is a tax on each turn of each run. The
prompt editor offers presets — cluster inspection, repository work, research, everything
— that fill the allow and deny lists; edit them afterwards as you like.

**Leave the prefix alone.** The environment briefing is about a thousand tokens on every
run, re-read from cache at a tenth the price of fresh input. Editing it invalidates that
cached prefix for every prompt at once, and each next run pays a full cache write at
1.25×. Same for a prompt's CLAUDE.md. This is a reason not to fiddle, not a reason to
trim.

Session continuity is the quiet one. `continueSession` makes each run resume the last,
which means the context grows forever and every turn of every future run pays to re-read
it. It is off by default, and the prompt editor shows what the last run actually carried
so the cost is visible before it hurts. Auto-resume is different and fine: it finishes
one task rather than accreting a month of them.

## License

MIT — see [LICENSE](LICENSE).
