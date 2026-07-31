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
# The e2e workspace has to exist for the install to resolve, but its browsers
# have no business in a runtime image — they are installed in CI, where the
# browser pass actually runs.
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
# push a branch, merge a pull request. ripgrep is what Claude's search tools use.
# kubectl is for looking at the result — whether the rollout came up, what the
# events say — using the pod's ServiceAccount, which is read-only by design.
ARG KUBECTL_MINOR=v1.33
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git openssh-client ripgrep jq less tini \
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

# Stamped by CI with the release tag or the commit SHA, and reported by
# /api/status. Without it a running instance cannot say which build it is, which
# is exactly the question after a deploy.
ARG APP_VERSION=dev

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist \
    PORT=8080 \
    HOME=/data/home

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
