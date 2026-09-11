#!/bin/sh
set -eu

require_safe_value() {
    variable_name=$1
    eval "variable_value=\${$variable_name:-}"
    case "$variable_value" in
        ""|*[!A-Za-z0-9._~-]*)
            echo "memberberry: $variable_name must contain only letters, digits, dot, underscore, tilde, or hyphen" >&2
            exit 1
            ;;
    esac
}

require_safe_value MEMBERBERRY_ADMIN
require_safe_value MINIO_ROOT_USER
require_safe_value MINIO_ROOT_PASSWORD
require_safe_value MINIO_BUCKET

mkdir -p /data /vault/notes
if [ ! -e /data/server.toml ]; then
    temporary=/data/.server.toml.memberberry-tmp
    cat > "$temporary" <<EOF
bind = "0.0.0.0:9010"
web_root = "/app/web"

[[vaults]]
slug = "personal"
name = "Personal"
path = "/vault"

[vaults.media]
backend = "s3"
bucket = "$MINIO_BUCKET"
region = "us-east-1"
endpoint = "http://minio:9000"
access_key_id = "$MINIO_ROOT_USER"
secret_access_key = "$MINIO_ROOT_PASSWORD"
allow_http = true
virtual_hosted_style = false
EOF
    chmod 600 "$temporary"
    mv "$temporary" /data/server.toml
fi

if [ ! -e /vault/access.toml ]; then
    temporary=/vault/.access.toml.memberberry-tmp
    cat > "$temporary" <<EOF
[[members]]
user = "$MEMBERBERRY_ADMIN"
role = "owner"
EOF
    mv "$temporary" /vault/access.toml
fi

exec memberberry "$@"
