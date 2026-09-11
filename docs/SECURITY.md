# Deployment security

Memberberry is self-hosted, not trustless. Use these controls before exposing it.

## Required controls

- Serve only through HTTPS. Keep the application origin private or loopback-bound and enable
  HSTS at the reverse proxy. The supplied Compose mapping is loopback-only.
- Keep MinIO private. Its API and console need no public host port; the bucket must deny
  anonymous access. Rotate the generated credential if `.env`, `/data/server.toml`, or a backup
  may have leaked.
- Restrict filesystem and backup access. Vaults are intentionally readable Markdown, not
  encrypted storage, and `access.toml` cannot protect against the host administrator.
- Protect `/data`: `auth.db` contains password hashes and sessions, while `server.toml` contains
  object-store credentials. Never put either inside a vault or version control.
- Run backups, restore drills, image updates, and `memberberry doctor` regularly. Review
  `audit.log` for authentication failures and privileged changes.
- Issue integrations vault-scoped API tokens with the least role needed. Revoke unused tokens
  and public share links; avoid never-expiring shares.

## Boundary and limits

All note, search, graph, task, history, media, presence, and public-share reads are filtered on
the server. Server administrator status does not grant vault-content access. A guessed media
hash is not authorization, and the MinIO bucket is never a public delivery surface.

Application ACLs do not encrypt files. A person with host, object-store, or backup access can
read all content. Revoking a user cannot erase an offline replica they already received. If a
vault uses Git, older content remains in Git history after an ACL becomes stricter. These are
consequences of portable Markdown and offline-first operation, not guarantees the deployment
layer can remove.

The server does not trust `X-Forwarded-For`; this prevents arbitrary clients spoofing audit and
rate-limit identity, but means a reverse proxy is treated as one peer for peer-level limits.
The clipper intentionally makes outbound requests and applies DNS-pinned SSRF controls. The
Compose app container therefore has outbound networking while MinIO remains only on the private
storage network.

Report suspected permission leaks immediately. Do not work around a denial by exposing a vault
directory, MinIO, a backup, or a derived index through a general-purpose static file server.
