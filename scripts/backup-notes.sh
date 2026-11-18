#!/usr/bin/env bash
set -euo pipefail
echo "Back up PostgreSQL database whatsapp_panel, Docker volume whatsapp-panel_panel_media, and the protected .runtime.env encryption key."
echo "Encrypt every backup with a separate key and periodically test restoration on an isolated system."
