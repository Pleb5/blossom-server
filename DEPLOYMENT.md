# Production Deployment

This runbook covers Docker Compose deployments that build the server from a Git
checkout. It assumes `config.yml` and blob data are persisted outside the
container.

## Before Updating

Identify the deployment instead of assuming that a DNS name is also an SSH
alias. Resolve the public name, compare its address with local SSH
configuration, then inspect running containers on the candidate host:

```sh
getent ahostsv4 blobs.example.com
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

For a Compose-managed container, the project directory is available from its
labels:

```sh
docker inspect CONTAINER --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
```

Confirm its persistent mounts before changing anything:

```sh
docker inspect CONTAINER --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

The data directory must map to `/app/data`, and the production configuration
should map to `/app/config.yml` read-only. Recreating a container is safe only
when these mounts are correct.

## Preserve Host Overrides

Production hosts may intentionally modify `docker-compose.yml` to bind only to
loopback, use a host-mounted data volume, or integrate with a reverse proxy. Do
not discard that dirty file during an update.

Inspect the checkout first:

```sh
git status --short
git diff -- docker-compose.yml
git remote -v
git branch --show-current
```

If the Compose file is the only local change, stash only that file. Fetch the
intended deployment repository explicitly because the checkout's configured
`origin` may point to a different mirror:

```sh
git stash push -m "VPS compose override" -- docker-compose.yml
git fetch DEPLOYMENT_REPOSITORY_URL master
git merge --ff-only FETCH_HEAD
git stash pop
```

Afterward, `git status --short` should show only the restored Compose override.
Verify the expected revision with `git rev-parse --short HEAD`. Do not push from
the production checkout merely because Git reports that it is ahead of its
configured `origin`.

## Configuration

`publicDomain` must be explicit in production. Descriptor URLs may use request
host information, but BUD-11 server-scoped authentication must not depend on an
untrusted `Host` header.

```yaml
publicDomain: "blobs.example.com"
```

Check the effective Compose configuration before rebuilding:

```sh
grep -n '^publicDomain:' config.yml
docker compose config --quiet
```

Never replace an existing production `config.yml` with `config.example.yml`
during an update.

## Build And Restart

Build first so a failed image build does not interrupt the running server. Start
the replacement only after the build succeeds:

```sh
docker compose build --pull blossom &&
docker compose up -d --no-deps blossom
```

Using `&&` prevents the restart when the build fails. When pasting plain
newline-separated commands, the shell runs each line sequentially but continues
after failures, so deployment commands should be run individually or joined with
`&&`.

## Verify

Inspect container state and startup logs:

```sh
docker compose ps
docker compose logs --tail=100 blossom
```

The logs should report a ready database and storage backend, initialized upload
workers, and the expected Blossom endpoints. Test both the loopback listener and
the public reverse proxy:

```sh
curl -fsSI http://127.0.0.1:HOST_PORT/
curl -fsSI https://blobs.example.com/
```

The public response should be successful over HTTPS and include Blossom CORS
headers. A missing optional `.env` file, Deno's experimental permissions notice,
and Node's `punycode` deprecation notice are currently non-fatal warnings.

## Budabit Deployment Profile

The current Budabit deployment uses:

- Public URL: `https://blossom.budabit.club`
- Checkout: `/opt/blossom-server`
- Compose service: `blossom`
- Container port: `3000`
- Host listener: `127.0.0.1:3001`
- Public TLS and reverse proxy: Caddy
- Persistence: host-mounted data directory at `/app/data`
- Configuration: `/opt/blossom-server/config.yml` mounted at `/app/config.yml`
  read-only

Its `docker-compose.yml` is intentionally different from the repository default
and should remain an unstaged local override. After deployment, verify both:

```sh
curl -fsSI http://127.0.0.1:3001/
curl -fsSI https://blossom.budabit.club/
```
