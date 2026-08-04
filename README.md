# KubeClaude

A web UI that runs Claude Code prompts on a schedule inside Kubernetes.

You define a task once — the instructions, the model, what Claude is allowed to touch,
which MCP servers it can reach — and KubeClaude runs it headless with the Claude CLI,
streams the output back live, and keeps track of what it cost.

The scheduling is built around how a Claude subscription actually works: besides cron, a
prompt can fire **as soon as a new 5-hour session window opens**, when a new week opens,
or once a configurable share of the token budget is free. And a run cut off by the quota
is not thrown away — KubeClaude parks it and **resumes the same Claude session** once
tokens come back, unless it can tell the task was already finished.

---

## What it does

**Chat.** Talk to Claude directly, with the same access a scheduled prompt gets. Each
message resumes the same session, so it keeps its context and you can steer it as it
works. When a conversation does what you want, save it as a prompt and put it on a
schedule. The composer completes on `@` (files in the working directory) and on `/` at
the start of a message (your saved prompts) — both plain text insertions, nothing is
interpreted as a command.

**Prompts.** A standing task: prompt text, model, permission mode, tool allow/deny
lists, env, MCP connections, a working directory, a `CLAUDE.md`, a timeout. Optionally
a repository to work in — see [Working in a repository](#working-in-a-repository).

**Goals.** A session that does not stop at one run: a mission, a checklist, and a loop
that iterates until the checklist is closed. See [Goals](#goals-that-keep-going).

**Triggers.** Any number per prompt:

| Trigger | Fires |
|---|---|
| `cron` | On a cron schedule, in a timezone you pick. After downtime it catches up **once**, not once per missed slot. |
| `interval` | Every N minutes. |
| `session_reset` | Once per rolling 5-hour window — immediately when none is open, then again the moment it rolls over. This is the "run whenever I have tokens again" trigger. |
| `weekly_reset` | Once per weekly window. |
| `quota_available` | When a configured share of the token budget is free. |
| `webhook` | An inbound POST to an unguessable URL — Asana, Jira, GitHub, anything that can call one. |

**Runs.** Executed through `claude --print --output-format stream-json`. Every message
is stored, so a run can be watched live over SSE or replayed later. Tokens, cost, turns,
per-model usage and API time all come from the CLI's own report.

**Quota accounting.** Usage lands in 5-hour and weekly windows opened the way Claude
opens them — on the first run after a reset. Set a token budget and the overview turns
into gauges; turn on the guard and KubeClaude holds runs back rather than burning the
last of your allowance. See [Quota, billing and the numbers](#quota-billing-and-the-numbers).

**Runs that stop short** are not failures, and are not filed as one. The Claude quota
running out marks a run `rate_limited`, and the scheduler queues a continuation with
`--resume <session-id>` once tokens return, so the model keeps its full context. One of
KubeClaude's *own* ceilings — the turn cap or the per-run token cap — marks it `capped`
instead: no sweep picks those up, since the same ceiling would stop the run in the same
place, so raise the limit and resume by hand.

Before resuming anything, KubeClaude asks whether the task was *already done* — resuming
finished work wastes exactly the tokens you were waiting for. Per prompt: `marker`
(default; Claude prints a sentinel line when finished — deterministic and free), `judge`
(a cheap model reads the transcript), or `always` / `never`.

**Authentication.** It asks you to set a password the first time you open it, and after
that you choose how to sign in. See [Who can reach it](#who-can-reach-it).

**MCP connections.** KubeClaude does **not** run MCP servers. It stores how to reach
servers that already run elsewhere and writes them into the `.mcp.json` it hands to
Claude. `${VAR}` placeholders are passed through untouched and expanded from the run's
environment, so tokens live in Kubernetes secrets, not in this database. Reach for MCP
when a service has no CLI — **GitHub and Kubernetes already have one**, and brokering
those same APIs through a server adds a network hop, a second auth system and a
component that can be down, for no capability you did not already have.

**Shared agents.** Reusable subagent definitions, attached to any prompt by name and
merged into `--agents`. A prompt's own inline JSON wins on a name collision, the same
precedence MCP connections use.

**Notifications.** Point Settings → Notifications at a webhook URL — a Slack incoming
webhook or any endpoint that takes JSON — and KubeClaude POSTs a summary when a run
finishes: the prompt, the outcome, the cost, the error if there was one. On by default
for failure, timeout, hitting a KubeClaude ceiling, or a rate limit with no auto-resume
scheduled; off by default for success, since a run succeeding is the expected, quiet
outcome. A target that is slow or unreachable never holds up the run queue — a failed
delivery only ever reaches the error feed.

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
| `KUBECLAUDE_AUTH_TOKEN` | — | A static credential accepted as `Authorization: Bearer` or `X-Api-Key`, on top of whatever login method is configured. |
| `AUTH_METHOD` | — | Pin the login method to `none`, `forms`, `basic` or `external`. Set it and the UI shows the choice as locked, so an instance deliberately placed behind an SSO proxy cannot have that turned off from inside the app. |
| `TRUST_PROXY` | `false` | Derive `request.ip` (the local-network bypass, the login lockout key) from `X-Forwarded-For`. Only set `true` behind a proxy that overwrites the header rather than appending to it. |
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
repo under `kubeclaude/`, as an ArgoCD Application: a Deployment, a Service, a Traefik
Ingress with TLS, a `local` PersistentVolume for `/data`, and an ExternalSecret that
pulls the Claude token out of Vault.

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
on every push to `main`; pull requests build the image but do not push it. That needs two
repository secrets — `DOCKERHUB_USERNAME`, and `DOCKERHUB_TOKEN`, an access token scoped
**Read & Write** rather than your password. To publish under a different namespace, set a
`DOCKERHUB_NAMESPACE` repository *variable*; the workflow falls back to `paganim`.

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
kubeconfig and still do nothing useful, because nothing told it there is a cluster worth
looking at or that pushing to git is how a deploy happens. Three places carry that
knowledge:

| Put it in | When it applies | Good for |
|---|---|---|
| **Environment briefing** (Settings) | Every run, always | "You are in a Kubernetes cluster. ArgoCD syncs from git and `selfHeal` reverts anything not in it. A republished `:latest` needs `rollout restart`." |
| **Appended system prompt** (per prompt) | Every run of one prompt | "Only ever touch the `media/` directory." "Never merge a PR that changes CI." |
| **The prompt text** | The task itself | "Review the open PRs and merge the green dependency ones." |

The briefing answers *"how do I tell it that it has a cluster?"*. It ships with a default
covering what is installed, what it may and may not touch, and the shapes a deploy takes.
Edit it in Settings; it is your cluster, and it should say so.

Two things a model that does not know them will fight your platform over, and both belong
in the briefing. **Git is the source of truth**: with `selfHeal` and `prune`, anything
created in-cluster that is not also in git gets reverted on the next sync, so a run that
edits a live Deployment may report success in the window before that happens. And **a
republished tag is invisible to ArgoCD** — when CI pushes `:latest` again the manifest is
byte-identical, so there is no drift to sync and the old pods keep running. That is the
case where `kubectl rollout restart` is the right answer rather than a workaround.

`kubectl` authenticates as the pod's ServiceAccount; the companion manifests grant read
access to everything except Secrets, plus enough write access to take a change all the way
to running. `EXPOSE_KUBERNETES=false` withholds cluster access entirely.

Worked example — a prompt that keeps dependency PRs moving: model `claude-sonnet-5`,
permission mode `acceptEdits`, allowed tools `Bash(gh:*)`, env
`GITHUB_TOKEN=${GITHUB_TOKEN}`, trigger `session_reset`, completion check `marker`.

---

## Working in a repository

Give a prompt, a chat or a goal a repository URL and a branch, and the checkout stops
being the prompt's problem.

**Before every run**, KubeClaude clones it into the working directory if it is not there,
then fetches and `reset --hard`s onto the branch — deliberately, rather than pulling. The
workspace is a scratch copy of the remote, and a run killed mid-rebase must not poison the
next one; anything worth keeping was pushed. If the clone or checkout fails the run
**fails**, because running against a stale directory would look like success.

**Committing and pushing need no setup in the prompt.** Every run gets a gitconfig with a
committer identity (Settings → Git), `init.defaultBranch=main`, `safe.directory`, and a
credential helper for github.com — a shell function that reads `GITHUB_TOKEN` from the
environment when git asks, so nothing secret is written to disk and rotating the token
needs no change here. `gh` sees the same token, so `gh pr create` works in the same run
that pushed the branch. A prompt can then be about the change rather than the plumbing:

> On `main`, run the test suite. If anything fails, fix it on a branch, push, and open a
> pull request describing what was wrong.

The remote has to be an `https://` or `git@host:owner/repo` URL. A local path is refused:
that string goes to `git clone`, and a prompt naming a path on the data volume is either a
mistake or an attempt to read something else on it.

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
| **External** | A reverse proxy in front — oauth2-proxy, Authelia, Cloudflare Access — has already authenticated the request. KubeClaude reads the user name from a header (`X-Forwarded-User` by default; empty means trust the proxy unconditionally). If the header stops arriving the request is refused, because a proxy that stopped sending it is a misconfiguration rather than an invitation. |
| **None** | Nobody is asked anything. Only sane behind a VPN or a proxy that gates access for you. |

**Skip authentication on the local network** is the other switch, the same one Sonarr and
Radarr offer: requests from `127.0.0.1`, `10.`, `172.16–31.`, `192.168.` and IPv6 ULA get
in without signing in. Convenient at home, and wrong the moment that port is reachable
from outside.

That switch has a sharp edge, so KubeClaude blunts it. Behind a reverse proxy or an
ingress the address it sees is the *proxy's*, which is itself private — so "my LAN" would
quietly mean "anyone who can reach the proxy", i.e. the internet. Any request carrying
`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `X-Forwarded-Host` or `CF-Connecting-IP`
while `TRUST_PROXY` is off is therefore **never** granted the bypass, whatever the address
it arrived from; the setup screen does not offer the option at all in that case, and
Settings → Security says so where the switch is. Set `TRUST_PROXY=true` — once the proxy
really overwrites the header — and the bypass judges the forwarded client address instead,
which is the address you meant.

By default KubeClaude never looks at `X-Forwarded-For` — it is a header any direct client
can set, so trusting it would let a remote attacker claim to be `127.0.0.1` and walk past
the local-network bypass, or rotate it to dodge the login lockout. Set `TRUST_PROXY=true`
only once something in front of KubeClaude actually **overwrites** that header rather than
appending to it (a correctly configured ingress, oauth2-proxy, Cloudflare Tunnel); with
nothing in front, or a proxy that merely appends, leave it off.

Three details worth knowing. Upgrading an instance that used `KUBECLAUDE_AUTH_TOKEN` does
not open a window — the setup screen requires that token before it will set a password, so
whoever gets there first cannot claim the instance. `AUTH_METHOD` in the environment wins
and the UI shows the method as locked, for the GitOps case where nothing inside the app
should be able to turn off the SSO proxy in front of it. And the API key and static token
work in every mode, including `external`, which is how a script talks to an instance whose
humans sign in through SSO.

---

## Goals that keep going

A prompt runs and finishes. A goal keeps working: a single Claude session put on a loop,
with a checklist it is trying to close. You give it a **mission** (the standing brief
every iteration reads), **objectives** (one line each, ticked off as they close — leave
the list empty and the goal is open-ended), a **cadence**, and optionally an **iteration
limit** so an unattended goal cannot run forever.

Each iteration is handed the mission, the objectives with their current state, and a
digest of what the last few iterations did. It is asked to do *one* meaningful unit of
work — carried through to something real and verified — and to end with a report:

```
PROGRESS: Added a backoff to the client and covered it with a test.
DONE: o1, o3
NEXT: Wire the same backoff into the worker.
```

That report is read mechanically, which is what keeps the loop cheap: no second model call
in the normal case, and the objective ids are checked against the list, so an iteration
cannot tick a box that was never there. Set a **review model** and a cheap model reads the
transcript instead, for when an iteration forgets to write one.

How it ends:

| Situation | What happens |
|---|---|
| Every objective ticked | `achieved`, unless you turned off "stop when achieved" — then it keeps iterating and improving. |
| Iteration limit reached | `abandoned`. Resuming lifts the limit. |
| Three failed or timed-out iterations in a row | Paused automatically. Something is wrong with the setup, and looping would spend the budget reproducing it. A restart of KubeClaude itself does **not** count — a deploy or a node drain is not the task failing. |
| Quota ran out mid-iteration | Nothing special: the run parks as `rate_limited` and auto-resume finishes that iteration before the loop moves on. |
| You pause it | The loop leaves it alone, and any iteration in flight is cancelled. "Iterate now" is refused until you resume it. |

A goal owns its own prompt — same runner, same quota accounting, same live output — so
every iteration is a normal run you can open, watch and replay. It does not appear in the
prompt list; it is configured from the goal instead.

Worked example — keeping a namespace healthy. **Mission** "Keep the media namespace
healthy: no CrashLoopBackOff, no pending PVCs, requests that match real usage. Change one
thing at a time and verify it. Never delete a StatefulSet." **Objectives** "Every pod is
running and ready", "No PVC pending over an hour". **Cadence** 60 minutes, permission mode
`bypassPermissions`, **stop when achieved** off — health is not a thing you finish.

---

## Tuning a run

Eight controls sit on the prompt, most with a global default behind them. The first four
decide how a run behaves; the rest decide what it is made of and what it may spend.

**Fallback models.** `--fallback-model`, a comma-separated chain. When the chosen model
is overloaded the CLI moves down the list instead of failing, and retries the primary at
the start of each turn. A scheduled run has nobody to retry it by hand, so `opus` with
`sonnet,haiku` behind it is the difference between the work happening on a smaller model
and not happening at all. Set it globally — capacity is a property of the account, not of
one task — and override it on the prompts that care.

**Effort.** `--effort`, one of `low`, `medium`, `high`, `xhigh`, `max`. How hard the model
works per turn, and roughly what it costs. Left empty the CLI decides, which is not the
same as choosing a level.

**Additional directories.** `--add-dir`, absolute paths. The working directory is already
writable; these are the extra ones. This is what lets a single prompt work across two
checkouts — read the manifests in one repository, change the code in another.

**A replacement system prompt.** `--system-prompt`, as opposed to the appended one. It
replaces Claude Code's own — everything it says about being an agent with tools included
— so leave it alone unless replacing exactly that is the point. The environment briefing
and the completion marker are still appended after it either way.

**Which settings files are read.** `--setting-sources`. Left alone the CLI reads the user,
project and local settings, and the *project* one belongs to whatever repository the run
just cloned — its hooks, its permissions, its MCP servers. A prompt that works in somebody
else's repository can narrow this to `user`, or to `none`.

### Spending less

KubeClaude does not control tokenization, prompt caching or compaction — the CLI owns all
three. What a wrapper controls is **how much conversation happens** and **what sits in the
cached prefix**, and that is where the money is.

**Cap the turns.** Every turn re-sends the whole conversation, so spend grows
superlinearly with turn count and a run that goes in circles can eat a window by itself.
`defaultMaxTurns` (120 out of the box) applies to any prompt that does not pin its own; a
prompt setting `0` opts out deliberately, and leaving it empty inherits the default.

The default is deliberately not tight. A run that hits the cap stops mid-task with its
working tree half-edited — thirty turns is enough to look something up and report, and
nowhere near enough to change code and open a pull request. The token ceiling below is the
budget guard; the turn cap is there to stop a genuinely stuck loop. A run that hits it is
marked `capped` and can be resumed from where it stopped.

**Set a ceiling.** Two of them, and the difference is how hard they stop. `--max-budget-usd`
is per prompt: the CLI stops *itself* once a run has spent that much and still reports what
it did. `runTokenCap` is global and blunter — it kills the process from outside, weighed by
the same `budgetBasis` as the gauges. Spend up to that point is still charged to the window,
and neither is ever auto-resumed, because retrying would spend the ceiling again for the
same result. Both are off by default.

**Shrink the tool list.** `--tools` decides which tools the model is told exist at all —
distinct from the allow list, which decides what may run without asking. Every tool carries
its schema in the system prompt of *every request*, so a prompt that only reads files pays
for WebFetch on every turn until you take it away. Three states: leave it alone for the
CLI's full set, list the ones to keep, or hand it none. The prompt editor offers presets —
cluster inspection, repository work, research — that fill the allow and deny lists.

**Leave the prefix alone.** The environment briefing is about a thousand tokens on every
run, re-read from cache at a tenth the price of fresh input. Editing it invalidates that
cached prefix for every prompt at once, and each next run pays a full cache write at 1.25×.
Same for a prompt's CLAUDE.md. A reason not to fiddle, not a reason to trim.

**Watch `continueSession`.** It makes each run resume the last, so the context grows
forever and every turn of every future run pays to re-read it. Off by default, and the
prompt editor shows what the last run actually carried so the cost is visible before it
hurts. Auto-resume is different and fine: it finishes one task rather than accreting a
month of them.

---

## Quota, billing and the numbers

The CLI needs credentials in its environment; KubeClaude passes exactly one set through to
every run and never writes them to disk.

| How you pay | Variable | How to get it |
|---|---|---|
| Pro / Max subscription | `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` on a machine where you are already logged in; it prints a long-lived token (`sk-ant-oat…`). |
| API credit (per token) | `ANTHROPIC_API_KEY` | Create a key in the [Claude Console](https://console.anthropic.com/settings/keys). |
| A gateway in front of Claude | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | Whatever your proxy issues. |

These are not interchangeable, and the difference is money. A subscription token spends
your plan's allowance — the same bucket as the desktop app and the terminal, no per-token
charge. An API key bills Console credit at published rates and has no allowance to run out
of. So KubeClaude forwards **exactly one** credential rather than letting the CLI choose:
a gateway if `ANTHROPIC_BASE_URL` is set, otherwise the subscription token, otherwise the
API key. Set both a token and a key and the key is ignored — Settings says so out loud, and
`/api/status` reports the resolved mode as `billingMode`.

The subscription token is the one that makes the rest of this app mean anything: 5-hour and
weekly windows, `session_reset` / `weekly_reset` / `quota_available` triggers and
auto-resume all exist because a subscription has windows to run out of. An API key never
rate-limits you that way, so those triggers degrade to plain schedules.

Interactive `claude login` is not an option in a pod — there is no browser to redirect to.
`claude setup-token` is the headless equivalent, and it is what the Kubernetes manifests
expect (`claude_code_oauth_token` in the ExternalSecret).

**On the allowance figures.** Anthropic publishes per-token API pricing, but not the
allowance behind a Pro or Max subscription — the figures circulating in the community
(roughly 44k per 5-hour window on Pro, 88k on Max 5x, 220k on Max 20x) are observed
estimates, not documented limits. Treat them as a starting point and calibrate against your
own overview. Leave the budgets at zero and it shows running totals instead of gauges.

**What counts as spend** matters more than the number you type. A run re-reads its whole
cached prefix on every turn, so `cache_read_input_tokens` dominates the raw total while
costing a tenth of a fresh input token — summing all four counters at face value would put
a single real run at several times a 44k budget. The **budget basis** decides how the raw
counters become spend:

| Basis | Counts | Use when |
|---|---|---|
| `weighted` (default) | input + output + 1.25 × cache writes + 0.1 × cache reads | You want the gauge to track what you are actually being charged for. |
| `input_output` | input + output only | You want to ignore caching entirely. |
| `total` | everything at face value | You are budgeting raw throughput, not cost. |

Run history keeps the raw counters either way; only the gauge and the quota guard read the
basis.

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

One process, one SQLite file, no external dependencies. State lives in `DATA_DIR`; back
that up and you have backed up KubeClaude.

### When something goes wrong

Two things exist because a self-running instance has nobody watching its logs.

**The error feed** — the **Errors** page, `/api/errors`. A request that threw, a rejection
nothing handled, a run that could not be started, and a page of the UI that failed to
render: all of them land in one list, with a stack. Identical faults are counted rather
than repeated, so a poll that has been failing every fifteen seconds since Tuesday is one
line saying so. Nothing here goes anywhere else — it is a local list, not telemetry.

**A copy before every migration.** A migration that succeeds but leaves the app unable to
start is the single failure it cannot repair from the inside, because the thing that would
fix it is the thing that is down. So before any migration is applied to a database that
already has a schema, `VACUUM INTO` writes a consistent copy to `DATA_DIR/backups`.
Restoring is deliberate — stop the pod, put the copy over `kubeclaude.db`, start it again
— and the files are listed at the bottom of the Errors page.

### API

| | |
|---|---|
| `GET /api/dashboard` | Everything the overview shows |
| `GET /api/status`, `/api/usage`, `/api/capabilities`, `/api/models` | Health, quota, what the runs can reach. `capabilities` includes the git identity and whether a GitHub token is forwarded — never the token |
| `GET POST /api/prompts`, `PATCH DELETE /api/prompts/:id` | Prompts |
| `POST /api/prompts/:id/run` | Queue a run now |
| `GET /api/prompts/:id/files` | Paths under a prompt's working directory, for the composer's `@` completion |
| `GET POST /api/prompts/:id/triggers`, `PATCH DELETE /api/triggers/:id` | Triggers |
| `POST /api/webhooks/:id/:token` | Fire a webhook trigger. Public: the token authenticates it |
| `GET POST /api/chats`, `GET PATCH DELETE /api/chats/:id` | Conversations |
| `POST /api/chats/:id/messages`, `/stop`, `/promote` | Reply, interrupt, save as a prompt |
| `GET POST /api/goals`, `GET PATCH DELETE /api/goals/:id` | Goals and their objectives |
| `POST /api/goals/:id/start`, `/pause`, `/iterate` | Resume the loop, hold it, run one iteration now |
| `GET /api/goals/:id/iterations` | The progress log |
| `GET /api/runs`, `/api/runs/:id`, `/api/runs/:id/events`, `/api/runs/:id/thread` | Runs |
| `POST /api/runs/:id/cancel`, `/resume`, `/follow-up` | Act on a run |
| `GET POST /api/mcp-servers`, `PATCH DELETE /api/mcp-servers/:id` | MCP connections |
| `GET POST /api/agents`, `PATCH DELETE /api/agents/:id` | Shared subagent definitions |
| `GET PATCH /api/settings`, `GET /api/settings/defaults` | Settings, and the shipped defaults |
| `GET POST DELETE /api/errors`, `DELETE /api/errors/:id` | The error feed |
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

Or one layer at a time: `npm run lint` (type-aware, zero warnings tolerated),
`lint:fix`, `typecheck`, `test:server`, `test:web`, `build`.

Linting is type-aware, which is the point: it is what catches a floating promise in the
queue — a run that silently never finishes — or a value off the CLI's JSON stream rendered
as `[object Object]`. There is no formatter here; the rules are chosen for what they catch.

Three test layers. **`server/test`** drives the queue, scheduler, goal loop and auth guard
against a stub `claude` binary, so the quota → park → resume → complete path is covered
without a token or a network; `api.test.ts` goes through the real HTTP stack with
`app.inject()`. **`web/src`** renders components in jsdom and proves a page that throws is
caught and recoverable. **`e2e/tests`** runs the built server, the built SPA and a real
Chromium over every page, failing on an uncaught page error as well as on assertions. The
e2e run starts its own server on a throwaway database with the stub CLI and no credentials,
so a full pass touches no cluster and spends no quota — it has to be safe to run on every
pull request, and from inside a KubeClaude working on this repository.

`/api/status` reports `version`, shown in the sidebar: CI stamps it `main-<sha>`, a release
tag stamps the version, and `dev` means a local build.

### Releasing

`latest` follows the tip of `main` — CI publishes it on every merge, once the tests and the
browser pass are green. A deployment that should only move when you say so pins a version:

```bash
git tag v1.4.2 && git push origin v1.4.2
```

That runs the whole gate again, then publishes `1.4.2`, `1.4` and `1`, and opens a GitHub
release. A pre-release (`v1.5.0-rc.1`) publishes only its exact version, so `:1` never
starts pointing at a release candidate.

---

## License

MIT — see [LICENSE](LICENSE).
