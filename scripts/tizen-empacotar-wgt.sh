#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_root="${CEBOLA_TIZEN_SDK_ROOT:-}"
profile="${CEBOLA_TIZEN_PROFILE:-}"

(( $# <= 1 )) || { echo "ERRO: informe no máximo um destino .wgt" >&2; exit 2; }
[[ -n "$sdk_root" ]] || { echo "ERRO: defina CEBOLA_TIZEN_SDK_ROOT" >&2; exit 2; }
[[ -n "$profile" ]] || { echo "ERRO: defina CEBOLA_TIZEN_PROFILE" >&2; exit 2; }

tizen_cli="$sdk_root/tools/ide/bin/tizen"
[[ -x "$tizen_cli" ]] || { echo "ERRO: CLI Tizen indisponível: $tizen_cli" >&2; exit 2; }

destination="${1:-$root/apps/tizen/dist/cebola-tizen.wgt}"
[[ "$destination" == *.wgt ]] || { echo "ERRO: o destino deve terminar em .wgt" >&2; exit 2; }
if [[ "$destination" != /* ]]; then
  destination="$PWD/$destination"
fi
[[ ! -L "$destination" ]] || { echo "ERRO: o destino não pode ser um link simbólico" >&2; exit 2; }
[[ ! -e "$destination" || -f "$destination" ]] || {
  echo "ERRO: o destino existente deve ser um arquivo regular" >&2
  exit 2
}

destination="$(realpath -m -- "$destination")"
app_root="$(realpath -m -- "$root/apps/tizen")"
source_config="$app_root/config.xml"
source_www="$app_root/www"
source_build="$app_root/.buildResult"

if [[ "$destination" == "$source_config" ]]; then
  echo "ERRO: o destino não pode sobrepor config.xml" >&2
  exit 2
fi
case "$destination" in
  "$source_www"|"$source_www"/*)
    echo "ERRO: o destino não pode ficar dentro de apps/tizen/www" >&2
    exit 2
    ;;
  "$source_build"|"$source_build"/*)
    echo "ERRO: o destino não pode ficar dentro de apps/tizen/.buildResult" >&2
    exit 2
    ;;
esac

staging=""
publish_tmp=""
cleanup() {
  [[ -z "$publish_tmp" ]] || rm -f -- "$publish_tmp"
  [[ -z "$staging" ]] || rm -rf -- "$staging"
}
trap cleanup EXIT

staging="$(mktemp -d)"

cp "$source_config" "$staging/config.xml"
cp -R "$source_www" "$staging/www"
cp -R "$app_root/services" "$staging/services"
cp "$root/third_party/nuvio-tvsmart/LICENSE" "$staging/services/NUVIO-LICENSE"
node "$root/scripts/tizen-build-engine.cjs" "$staging/services/engine-core.cjs" >/dev/null

"$tizen_cli" build-web -- "$staging" >/dev/null
"$tizen_cli" package -t wgt -s "$profile" -- "$staging/.buildResult" >/dev/null

shopt -s nullglob
packages=("$staging/.buildResult"/*.wgt)
(( ${#packages[@]} == 1 )) || { echo "ERRO: esperado exatamente um .wgt" >&2; exit 2; }

"$root/scripts/tizen-verificar-wgt.sh" "${packages[0]}" >/dev/null
destination_dir="$(dirname "$destination")"
mkdir -p "$destination_dir"
publish_tmp="$(mktemp "$destination_dir/.cebola-tizen-wgt.XXXXXX")"
cp "${packages[0]}" "$publish_tmp"
mv -f "$publish_tmp" "$destination"
publish_tmp=""
printf '%s\n' "$destination"
