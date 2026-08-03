# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Native deps for better-sqlite3 when no prebuilt binary matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
# The e2e workspace has to exist for the install to resolve, but nothing here
# should fetch a browser: CI installs its own for the e2e pass, and the runtime
# stage installs the one runs actually use, to a shared path.
COPY e2e/package.json e2e/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --no-audit --no-fund

# server/ and web/ each carry their own tsconfig; there is no root one to copy.
COPY server server
COPY web web
RUN npm run build

# Drop dev dependencies from what we ship.
RUN npm prune --omit=dev

# --------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# git and gh are what a prompt needs to actually finish a job: clone a repo,
# push a branch, merge a pull request. ripgrep is what Claude's search tools use,
# and python3 is what it reaches for the moment a shell one-liner is not enough —
# it was in the build stage only, so runs found it missing and spent a turn
# discovering that.
# kubectl is for looking at the result — whether the rollout came up, what the
# events say — using the pod's ServiceAccount, which is read-only by design.
ARG KUBECTL_MINOR=v1.33
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git openssh-client ripgrep jq less tini \
        python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL "https://pkgs.k8s.io/core:/stable:/${KUBECTL_MINOR}/deb/Release.key" \
        | gpg --dearmor -o /usr/share/keyrings/kubernetes-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/kubernetes-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kubernetes-archive-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${KUBECTL_MINOR}/deb/ /" \
        > /etc/apt/sources.list.d/kubernetes.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh kubectl \
    && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI is the engine; KubeClaude only drives it.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

# A headless browser, for runs that have to look at a rendered page rather than
# at HTML — a screenshot of a dashboard, a check that a deploy actually serves
# something.
#
# It has to be baked in. The image runs as an unprivileged user, so a run cannot
# install one for itself: `playwright install chromium` downloads happily into
# $HOME and then fails to launch on missing shared libraries, and installing
# those needs a root nobody has. That failure mode costs a whole session to
# discover, because the download succeeding looks like progress.
#
# Installed to a root-owned path that everyone can read, so no run can corrupt
# the browser for the next one, and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD stops a
# project's own postinstall from fetching a second copy into $HOME.
ARG PLAYWRIGHT_VERSION=1.56.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx --yes playwright-core@${PLAYWRIGHT_VERSION} install --with-deps chromium-headless-shell \
    && chmod -R a+rX /opt/pw-browsers \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Stamped by CI with the release tag or the commit SHA, and reported by
# /api/status. Without it a running instance cannot say which build it is, which
# is exactly the question after a deploy.
ARG APP_VERSION=dev

# PLAYWRIGHT_BROWSERS_PATH is set above, next to the install. PLAYWRIGHT_SKIP_
# BROWSER_DOWNLOAD below is the other half of it: a run that npm-installs a
# project with Playwright among its dependencies must not have the postinstall
# pull a second browser into $HOME — slow, and unlaunchable when it lands.
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist \
    PORT=8080 \
    HOME=/data/home \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# Runs as an unprivileged user; /data is the only writable path it needs.
# HOME lives under it too, so git and gh have somewhere to write.
RUN mkdir -p /data/home && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME ["/data"]

# tini reaps the Claude CLI processes KubeClaude spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
