# Docker deployment on the Alibaba Cloud ECS host

This deployment runs the relay behind an existing Traefik instance at
`https://relay.example.com`. It does not publish a host port. Traefik
reaches port 8787 through the external Docker network `ecs-network`.

## Prerequisites

- Docker Engine with the Compose plugin on the ECS host.
- An existing Traefik container attached to `ecs-network`.
- DNS for `relay.example.com` pointing to the ECS host.
- A Traefik certificate resolver named `aliyun`.
- A workstation capable of building `linux/amd64` Docker images.

The production ECS has limited memory. Do not build this image on that host:
`better-sqlite3` may require native compilation, which can exhaust memory and
make other production services unresponsive. Build and test on a workstation,
then transfer the image.

## Configure

From the repository root:

```sh
cp .env.example .env
```

Review `.env`. `RELAY_ORIGIN` must exactly match the public origin used by the
clients, including `https://` and with no trailing slash. The defaults target
the existing ECS deployment.

Create the data directory before starting the service. The image runs as UID
and GID 1000:

```sh
mkdir -p data
chmod 700 data
```

On the ECS host, ensure the directory is owned by UID/GID 1000 before starting
the container:

```sh
sudo chown 1000:1000 data
```

## Build and test off-host

Choose an immutable image tag, normally the Git commit being deployed:

```sh
export RELAY_IMAGE_TAG="$(git rev-parse HEAD)"
docker build --platform linux/amd64 \
  --tag "iterm2-companion-relay:${RELAY_IMAGE_TAG}" .
```

The Dockerfile runs all 370 upstream tests serially during the build. Inspect
the final image contract:

```sh
docker image inspect "iterm2-companion-relay:${RELAY_IMAGE_TAG}" \
  --format 'arch={{.Architecture}} user={{.Config.User}} health={{json .Config.Healthcheck}}'
```

The architecture must be `amd64`, the user must be `node`, and the health check
must be present.

## First deployment

Copy the repository deployment files to the ECS stack directory:

```sh
ssh ecs 'sudo mkdir -p /opt/stacks/iterm2-companion-relay/data'
scp compose.yml .env.example ecs:/tmp/
ssh ecs 'sudo cp /tmp/compose.yml /opt/stacks/iterm2-companion-relay/compose.yml'
```

Create `/opt/stacks/iterm2-companion-relay/.env` from `.env.example` on the
server and set `IMAGE_TAG` to the immutable tag built above. Do not replace an
existing production `.env` without reviewing it first.

Transfer the image without storing an uncompressed archive on either side:

```sh
docker save "iterm2-companion-relay:${RELAY_IMAGE_TAG}" | gzip | \
  ssh ecs 'sudo docker load'
```

The following operation creates or replaces the relay container. Existing
WebSockets disconnect briefly and clients reconnect; the SQLite pairing data is
preserved:

```sh
ssh ecs \
  'cd /opt/stacks/iterm2-companion-relay && sudo docker compose up -d --no-build'
```

## Verify

Check the container and its internal metrics endpoint:

```sh
ssh ecs 'sudo docker ps --filter name=iterm2-companion-relay'
ssh ecs \
  'sudo docker exec iterm2-companion-relay node -e "fetch(\x27http://127.0.0.1:8787/metrics\x27).then(async r=>{console.log(r.status); console.log((await r.text()).slice(0,500))})"'
```

Then verify the public route and TLS certificate:

```sh
curl --fail --silent --show-error --output /dev/null \
  https://relay.example.com/
```

The public `/metrics` endpoint is intentionally denied by the relay because it
is not a loopback request.

View recent lifecycle logs without enabling verbose payload diagnostics:

```sh
ssh ecs 'sudo docker logs --since 10m iterm2-companion-relay'
```

## Upgrade

Build a new immutable tag off-host, transfer it with `docker save | gzip`, then
update only `IMAGE_TAG` in the server-side `.env`. Applying Compose replaces the
container, disconnecting current sockets briefly while preserving pairings:

```sh
ssh ecs \
  'cd /opt/stacks/iterm2-companion-relay && sudo docker compose up -d --no-build'
```

Do not run `docker compose build` on the production ECS.

## Rollback

Set `IMAGE_TAG` in the server-side `.env` to the previous image tag and apply
Compose again. This briefly reconnects active clients but does not remove the
database:

```sh
ssh ecs \
  'cd /opt/stacks/iterm2-companion-relay && sudo docker compose up -d --no-build'
```

Never delete `data/relay.db` during an upgrade or rollback. Losing it forces all
devices to pair again.
