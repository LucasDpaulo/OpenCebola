#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/roku"
DESTINATION="${1:-$APP/dist/cebola-roku.zip}"
build_version="${CEBOLA_ROKU_BUILD_VERSION-}"

case "$build_version" in
  ''|*[!0-9]*) echo "ERRO: CEBOLA_ROKU_BUILD_VERSION deve ser inteiro entre 1 e 99999" >&2; exit 2 ;;
esac
(( 10#$build_version >= 1 && 10#$build_version <= 99999 )) || {
  echo "ERRO: CEBOLA_ROKU_BUILD_VERSION deve ser inteiro entre 1 e 99999" >&2
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

cp "$APP/manifest" "$STAGING/manifest"
cp -R "$APP/source" "$APP/components" "$APP/images" "$STAGING/"
sed -i -E "s/^build_version=.*/build_version=$((10#$build_version))/" "$STAGING/manifest"
# URL das telas opcional (dev aponta para o PC na rede local); sem ela vale a do manifest fonte.
if [[ -n "${CEBOLA_ROKU_TELAS_URL-}" ]]; then
  case "$CEBOLA_ROKU_TELAS_URL" in
    https://*|http://*) ;;
    *) echo "ERRO: CEBOLA_ROKU_TELAS_URL deve começar com http:// ou https://" >&2; exit 2 ;;
  esac
  case "$CEBOLA_ROKU_TELAS_URL" in
    *[\|\&\ ]*) echo "ERRO: CEBOLA_ROKU_TELAS_URL contém caracteres inválidos" >&2; exit 2 ;;
  esac
  sed -i -E "s|^cebola_telas_url=.*|cebola_telas_url=$CEBOLA_ROKU_TELAS_URL|" "$STAGING/manifest"
fi
bash "$ROOT/scripts/roku-verificar-pacote.sh" "$STAGING"
rm -f "$DESTINATION"
(cd "$STAGING" && zip -qr "$DESTINATION" manifest source components images)
unzip -t "$DESTINATION" >/dev/null
echo "OK: pacote Roku criado em $DESTINATION"
