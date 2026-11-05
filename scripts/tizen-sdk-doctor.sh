#!/usr/bin/env bash
# Relata a disponibilidade do SDK Tizen, sem instalar, autenticar, assinar ou empacotar.
set -euo pipefail

sdk_root="${CEBOLA_TIZEN_SDK_ROOT:-${TIZEN_STUDIO_HOME:-}}"

if [[ -n "$sdk_root" ]]; then
  tizen_cli="$sdk_root/tools/ide/bin/tizen"
  sdb_cli="$sdk_root/tools/sdb"
  [[ -x "$tizen_cli" ]] || tizen_cli="missing"
  [[ -x "$sdb_cli" ]] || sdb_cli="missing"
else
  tizen_cli="$(command -v tizen || true)"
  sdb_cli="$(command -v sdb || true)"
  [[ -n "$tizen_cli" ]] || tizen_cli="missing"
  [[ -n "$sdb_cli" ]] || sdb_cli="missing"
fi

printf 'TIZEN_CLI=%s\nSDB_CLI=%s\n' "$tizen_cli" "$sdb_cli"
if [[ "$tizen_cli" == missing || "$sdb_cli" == missing ]]; then
  echo 'SDK_READY=no'
  exit 2
fi
echo 'SDK_READY=yes'
