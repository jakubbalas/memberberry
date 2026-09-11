# Container deployment

The root `compose.yaml` runs Memberberry with a private MinIO object store. The browser-facing
port is published on loopback only; put a TLS reverse proxy on the same host in front of it.
MinIO's API and console are not published.

## First start

1. Copy `deploy/.env.example` to `.env`, set the administrator name, and replace the MinIO
   password with `openssl rand -hex 32`. Keep `.env` mode `0600`.
2. Build the image: `docker compose build memberberry`.
3. Create the first login without putting its password in the process list:

   ```sh
   printf '%s\n' "$MEMBERBERRY_PASSWORD" | \
     docker compose run --rm -T memberberry user setup \
       --username "$(sed -n 's/^MEMBERBERRY_ADMIN=//p' .env)" --password-stdin
   ```

4. Start the services: `docker compose up -d`.
5. Confirm `docker compose ps` reports Memberberry healthy, then open
   `http://127.0.0.1:9010` or the HTTPS reverse-proxy URL.

On the first container start, the entrypoint creates `/data/server.toml`, a `personal` vault
at `/vault`, and a deny-by-default `access.toml` whose sole owner is `MEMBERBERRY_ADMIN`.
Subsequent starts never replace either file. The three named volumes contain server state, the
vault, and MinIO objects respectively.

## TLS proxy

Terminate TLS at Caddy, nginx, Traefik, or an equivalent proxy on the same machine and proxy to
`127.0.0.1:9010`. Preserve WebSocket upgrades. Do not change the Compose port binding to
`0.0.0.0` merely to reach a proxy running on another host; use a private network or run the
proxy beside Memberberry. Forwarded client-IP headers are deliberately not trusted, so rate
limits and audit entries record the proxy peer rather than accepting a spoofable header.

The application container runs as UID 10001. If replacing named volumes with bind mounts, make
the data and vault directories writable by that UID before starting it. Keep `/data/server.toml`
mode `0600`: it contains the S3 credential.

## Operations

- Upgrade with `docker compose build --pull memberberry && docker compose up -d`.
- Read logs with `docker compose logs -f memberberry`.
- Run integrity checks with `docker compose exec memberberry memberberry doctor --config /data/server.toml`.
- Take and restore backups as described in [BACKUP.md](BACKUP.md).
- Review the security boundary before exposing a server: [SECURITY.md](SECURITY.md).

The Compose file is a single-host baseline, not an orchestrator template. For external S3,
replace the generated vault media table in `/data/server.toml`, remove the MinIO services and
volume, and keep the bucket private.
