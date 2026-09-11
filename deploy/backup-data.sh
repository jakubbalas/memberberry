#!/bin/sh
set -eu

backup_root=${BACKUP_ROOT:-/backups}
backup_name=${BACKUP_NAME:-}
data_source=${MEMBERBERRY_DATA_SOURCE:-/sources/data}
vault_source=${MEMBERBERRY_VAULT_SOURCE:-/sources/vault}
minio_source=${MEMBERBERRY_MINIO_SOURCE:-/sources/minio}

case "$backup_name" in
    ""|*[!A-Za-z0-9._-]*)
        echo "backup: BACKUP_NAME must contain only letters, digits, dot, underscore, or hyphen" >&2
        exit 1
        ;;
esac

for source in "$data_source" "$vault_source" "$minio_source"; do
    if [ ! -d "$source" ]; then
        echo "backup: source directory does not exist: $source" >&2
        exit 1
    fi
done

mkdir -p "$backup_root"
partial="$backup_root/.$backup_name.partial"
destination="$backup_root/$backup_name"
if [ -e "$partial" ] || [ -e "$destination" ]; then
    echo "backup: destination already exists: $destination" >&2
    exit 1
fi

mkdir "$partial"
cleanup() {
    rm -rf "$partial"
}
trap cleanup EXIT HUP INT TERM

tar -czf "$partial/server-data.tar.gz" -C "$data_source" .
tar -czf "$partial/vault.tar.gz" -C "$vault_source" .
tar -czf "$partial/minio.tar.gz" -C "$minio_source" .

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$partial" && sha256sum ./*.tar.gz > SHA256SUMS)
elif command -v shasum >/dev/null 2>&1; then
    (cd "$partial" && shasum -a 256 ./*.tar.gz > SHA256SUMS)
else
    echo "backup: no SHA-256 utility is installed" >&2
    exit 1
fi

mv "$partial" "$destination"
trap - EXIT HUP INT TERM
printf 'backup: wrote %s\n' "$destination"
