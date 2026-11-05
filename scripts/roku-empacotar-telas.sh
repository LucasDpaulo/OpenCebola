#!/usr/bin/env bash
# Empacota a biblioteca de telas (ComponentLibrary) do app Roku.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TELAS="$ROOT/apps/roku/telas"
DESTINATION="${1:-$ROOT/apps/roku/dist/cebola-roku-telas.zip}"
[[ -f "$TELAS/components/InstanceConfig.brs" ]] || {
  echo 'ERRO: execute npm run native:configure antes de empacotar as telas.' >&2
  exit 2
}

if [[ "$DESTINATION" != /* ]]; then
  BASE_DIR="${INIT_CWD:-$PWD}"
  DESTINATION="$BASE_DIR/$DESTINATION"
fi

mkdir -p "$(dirname "$DESTINATION")"
DESTINATION="$(cd "$(dirname "$DESTINATION")" && pwd)/$(basename "$DESTINATION")"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT HUP INT TERM

cp "$TELAS/manifest" "$STAGING/manifest"
cp -R "$TELAS/components" "$STAGING/"
# build_version opcional (o deploy passa o run_number); sem ele vale o do manifest fonte.
if [[ -n "${CEBOLA_ROKU_BUILD_VERSION-}" ]]; then
  case "$CEBOLA_ROKU_BUILD_VERSION" in
    ''|*[!0-9]*) echo "ERRO: CEBOLA_ROKU_BUILD_VERSION deve ser inteiro" >&2; exit 2 ;;
  esac
  sed -i -E "s/^build_version=.*/build_version=$((10#$CEBOLA_ROKU_BUILD_VERSION))/" "$STAGING/manifest"
fi
bash "$ROOT/scripts/roku-verificar-pacote.sh" --telas "$STAGING"
rm -f "$DESTINATION"
(cd "$STAGING" && zip -qr "$DESTINATION" manifest components)
unzip -t "$DESTINATION" >/dev/null
echo "OK: biblioteca de telas Roku criada em $DESTINATION"
