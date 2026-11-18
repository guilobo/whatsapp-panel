#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/whatsapp-panel"
EVOGO="$HOME/evolution-go-deploy"
ENV_FILE="$ROOT/.runtime.env"
PUBLIC_URL="${PUBLIC_URL:-}"
if [[ ! "$PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
  echo "Set PUBLIC_URL to your HTTPS panel URL (for example https://panel.example.com)." >&2
  exit 1
fi
PUBLIC_DOMAIN="${PUBLIC_URL#https://}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN%/}"
mkdir -p "$ROOT"
chmod 700 "$ROOT"
umask 077
printf '%s\n' "PUBLIC_DOMAIN=$PUBLIC_DOMAIN" > "$ROOT/.env"
chmod 600 "$ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo "Protected runtime environment already exists; leaving it unchanged."
  exit 0
fi
if [[ ! -f "$EVOGO/.env" ]]; then echo "Evolution Go .env was not found." >&2; exit 1; fi
API_KEY="$(sed -n 's/^GLOBAL_API_KEY=//p' "$EVOGO/.env" | head -n 1 | sed 's/^"//;s/"$//')"
if [[ -z "$API_KEY" ]]; then echo "GLOBAL_API_KEY is missing." >&2; exit 1; fi
if ! docker network inspect evolution-go_default >/dev/null 2>&1; then echo "Evolution Go Docker network is missing." >&2; exit 1; fi
if ! docker exec evolution-go-postgres pg_isready -U postgres -d evogo_auth >/dev/null 2>&1; then echo "Evolution Go PostgreSQL is unavailable." >&2; exit 1; fi
DB_PASS="$(openssl rand -hex 32)"
ENC_KEY="$(openssl rand -hex 32)"
ROLE_EXISTS="$(docker exec evolution-go-postgres psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='whatsapp_panel'" | tr -d '[:space:]')"
if [[ "$ROLE_EXISTS" == "1" ]]; then
  docker exec evolution-go-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE whatsapp_panel WITH LOGIN PASSWORD '$DB_PASS'" >/dev/null
else
  docker exec evolution-go-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE whatsapp_panel WITH LOGIN PASSWORD '$DB_PASS'" >/dev/null
fi
DB_EXISTS="$(docker exec evolution-go-postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='whatsapp_panel'" | tr -d '[:space:]')"
if [[ "$DB_EXISTS" != "1" ]]; then
  docker exec evolution-go-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE whatsapp_panel OWNER whatsapp_panel" >/dev/null
fi
printf '%s\n' "PORT=3000" "PUBLIC_URL=$PUBLIC_URL" "EVOLUTION_URL=http://evolution-go:8080" "EVOLUTION_API_KEY=$API_KEY" "DATABASE_URL=postgresql://whatsapp_panel:$DB_PASS@evolution-go-postgres:5432/whatsapp_panel" "APP_ENCRYPTION_KEY=$ENC_KEY" "MEDIA_DIR=/app/data/media" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Private app database and runtime secrets are ready."
