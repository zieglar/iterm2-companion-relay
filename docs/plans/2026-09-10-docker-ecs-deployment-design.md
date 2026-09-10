# Docker ECS Deployment Design

## Goal

Make the repository self-contained for building and deploying the relay on an
Alibaba Cloud ECS host at a user-configured public hostname.

## Approach

Build the checked-out repository directly with a multi-stage Dockerfile. The
build stage installs native build dependencies, installs locked Node packages,
runs the test suite, and removes development dependencies. The runtime stage
contains only Node, the application, and production dependencies.

Docker Compose defines the production runtime contract and connects the relay
to the existing external `ecs-network`. Traefik discovers the container through
labels, terminates TLS, and routes the public hostname to port 8787 without
publishing a host port.

## Security and State

- Run as the image's unprivileged `node` user.
- Use a read-only root filesystem, drop all Linux capabilities, and enable
  `no-new-privileges`.
- Mount only `./data` for the SQLite pairing database and a constrained tmpfs
  for `/tmp`.
- Keep secrets and runtime state out of Git.
- Trust proxy headers because the service is reachable only through the
  authoritative Traefik network path.
- Disable relay and Traefik access logging to preserve the relay's
  zero-retention posture.

## Operations

The repository will include an environment example and an ECS-specific runbook
covering configuration, off-host `linux/amd64` builds, deployment, health
checks, upgrades, and rollback. Off-host builds are preferred because compiling
`better-sqlite3` on the small production ECS previously exhausted memory.

## Verification

Validate the Compose model, build the target architecture image, run the test
suite during the image build, start an isolated local container with a temporary
database, and confirm its `/metrics` health endpoint responds successfully.
