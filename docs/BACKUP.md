# Backups and restore

Memberberry backups must cover three stores together:

- `memberberry-data`: `server.toml`, `auth.db`, audit logs, shared emoji, and user state.
- `memberberry-vault`: plain Markdown, `access.toml`, drawings, history, and CRDT recovery state.
- `minio-data`: the S3-compatible media objects referenced by the Markdown.

`deploy/backup.sh` stops Memberberry first so graceful shutdown flushes accepted CRDT edits to
Markdown, then stops MinIO and runs the Compose `backup` job over read-only mounts. It writes
three compressed archives and `SHA256SUMS` into one atomically published timestamped directory,
then restarts both services. A failed job removes its partial directory and does not overwrite an
existing backup.

Run it manually with `make backup`, or give it a stable unique name with
`deploy/backup.sh before-upgrade-20260910`. Schedule that command with the host's systemd timer,
cron, or backup controller. The job deliberately has no retention policy: deletion belongs in
the operator's independently tested backup system, not in the application script.

Copy completed directories off the host. Backups contain plaintext notes, password hashes,
session material, and the MinIO credential; encrypt them at rest and restrict access. A backup
that has never been restored is unverified.

## Restore drill

1. Stop the stack: `docker compose down`.
2. Verify the selected directory: `(cd backups/<name> && sha256sum -c SHA256SUMS)`.
3. Ensure the three Compose volumes are empty. Never extract over a live or populated store.
4. Extract each archive into its matching volume using a short-lived Alpine container, for
   example for the vault:

   ```sh
   docker run --rm \
     -v memberberry_memberberry-vault:/restore \
     -v "$PWD/backups/<name>:/backup:ro" \
     alpine:3.21 sh -c 'cd /restore && tar -xzf /backup/vault.tar.gz'
   ```

   Repeat with `server-data.tar.gz` into `memberberry_memberberry-data` and `minio.tar.gz`
   into `memberberry_minio-data`. Confirm actual volume names with `docker volume ls`; Compose
   project-name overrides change their prefix.
5. Start the stack, sign in, open notes with media, and run `memberberry doctor` inside the app
   container. Test both an ordinary note and a recently edited one.

For a non-Compose deployment, stop every writer and snapshot the data directory, every complete
vault root, and the object store at the same logical point. Backing up only `notes/` preserves
the C2 artifact but loses accounts, permissions outside `access.toml`, media, history, and
possibly accepted edits still represented by CRDT recovery state.
