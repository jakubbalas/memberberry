#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose=(docker compose --project-directory "$project_root" --file "$project_root/compose.yaml")
backup_name=${1:-$(date -u +%Y%m%dT%H%M%SZ)}

case "$backup_name" in
    ""|*[!A-Za-z0-9._-]*)
        echo "backup: name must contain only letters, digits, dot, underscore, or hyphen" >&2
        exit 1
        ;;
esac

restart_services() {
    "${compose[@]}" up --detach minio memberberry >/dev/null
}
trap restart_services EXIT HUP INT TERM

"${compose[@]}" stop memberberry minio
BACKUP_NAME=$backup_name "${compose[@]}" --profile backup run --rm backup
restart_services
trap - EXIT HUP INT TERM
