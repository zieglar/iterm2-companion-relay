# Docker ECS Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a secure, self-contained Docker deployment for the existing Alibaba Cloud ECS relay.

**Architecture:** A multi-stage Dockerfile builds the checked-out source and produces a non-root production image. Docker Compose supplies the relay runtime settings, persistent SQLite storage, hardened container controls, and Traefik routing on the existing external ECS network.

**Tech Stack:** Node.js 20, npm, Docker BuildKit, Docker Compose, Traefik, SQLite

---

### Task 1: Add the container build

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1: Add a multi-stage Dockerfile**

Use a digest-pinned Node 20 Bookworm image. Install build tools only in the
builder, run `npm ci` and `npm test`, prune development dependencies, copy only
runtime files to the final image, and run as `node` with an HTTP health check.

**Step 2: Limit the build context**

Exclude Git metadata, dependencies, logs, local environment files, SQLite
state, coverage, and editor files.

**Step 3: Build the image**

Run: `docker build --platform linux/amd64 -t iterm2-companion-relay:local .`

Expected: Build succeeds and all Vitest tests pass in the build stage.

### Task 2: Add the production Compose contract

**Files:**
- Create: `compose.yml`
- Create: `.env.example`
- Modify: `.gitignore`

**Step 1: Add non-secret deployment variables**

Define the public relay origin, hostname, image tag, container name, external
network, and data directory in `.env.example`.

**Step 2: Add the Compose service**

Configure the relay environment, SQLite bind mount, external network, Traefik
TLS routing, read-only root, constrained tmpfs, dropped capabilities,
`no-new-privileges`, and a non-root user. Do not publish a host port.

**Step 3: Protect local deployment state**

Ignore `.env` and the root `data/` directory.

**Step 4: Validate configuration**

Run: `cp .env.example .env && docker compose config --quiet`

Expected: Exit code 0 with no interpolation or schema errors.

### Task 3: Document ECS operations

**Files:**
- Create: `docs/ECS_DOCKER_DEPLOYMENT.md`
- Modify: `README.md`

**Step 1: Write the deployment runbook**

Document prerequisites, first deployment, off-host `linux/amd64` image transfer,
data permissions, verification, logs, upgrades, and rollback. Explicitly warn
against native image builds on the memory-constrained production ECS.

**Step 2: Link the runbook**

Add a concise Docker/ECS deployment link to the README without replacing the
upstream systemd documentation.

### Task 4: Verify the result

**Files:**
- Verify all files above

**Step 1: Run the upstream test suite**

Run: `npm test`

Expected: All tests pass.

**Step 2: Inspect the image contract**

Run: `docker image inspect iterm2-companion-relay:local`

Expected: Architecture is `amd64`, configured user is `node`, and a health
check is present.

**Step 3: Start an isolated container**

Run the image on a temporary Docker network and temporary data directory with a
loopback-published test port, then request `/metrics` and inspect its health.

Expected: HTTP 200 and container health becomes `healthy`.

**Step 4: Review changes and commit**

Run: `git diff --check && git status --short`

Expected: No whitespace errors and only intended deployment files are changed.
