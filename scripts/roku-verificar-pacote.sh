#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODO="casca"
if [[ "${1:-}" == "--telas" ]]; then MODO="telas"; shift; fi
APP="${1:-$ROOT/apps/roku}"

if [[ "$MODO" == "telas" ]]; then
  # Biblioteca de telas: manifest próprio que declara a lib + componentes.
  for path in manifest components/CebolaApp.xml components/CebolaApp.brs components/ApiTask.xml components/ApiTask.brs components/PairingTask.xml components/PairingTask.brs; do
    [[ -s "$APP/$path" ]] || { echo "ERRO: arquivo da biblioteca ausente ou vazio: $path" >&2; exit 2; }
  done
  grep -E -q '^sg_component_libs_provided=CebolaTelas$' "$APP/manifest" || {
    echo "ERRO: manifest das telas deve conter sg_component_libs_provided=CebolaTelas" >&2
    exit 2
  }
  if grep -r -n -E -i '(password|token|secret)[[:space:]]*=' "$APP" --exclude='PairingTask.brs'; then
    echo "ERRO: possível credencial embutida na biblioteca Roku" >&2
    exit 3
  fi
  echo "OK: estrutura da biblioteca de telas Roku pronta."
  exit 0
fi

required=(
  manifest
  source/main.brs
  components/MainScene.xml
  components/MainScene.brs
)
for path in "${required[@]}"; do
  [[ -s "$APP/$path" ]] || { echo "ERRO: arquivo Roku ausente ou vazio: $path" >&2; exit 2; }
done

for field in major_version minor_version build_version; do
  grep -E -q "^${field}=[0-9]+$" "$APP/manifest" || {
    echo "ERRO: manifest Roku deve conter $field numérico" >&2
    exit 2
  }
done

if grep -r -n -E -i '(password|token|secret)[[:space:]]*=' "$APP" --exclude='PairingTask.brs'; then
  echo "ERRO: possível credencial embutida no pacote Roku" >&2
  exit 3
fi

# A casca é definitiva e não fala com a API: pareamento, sessão e perfis vivem nas telas.
if grep -r -n '/v1/' "$APP/source" "$APP/components"; then
  echo "ERRO: a casca Roku não pode chamar a API (/v1/)" >&2
  exit 3
fi

grep -E -q '^cebola_telas_url=https?://[^ ]+$' "$APP/manifest" || {
  echo "ERRO: manifest Roku deve conter cebola_telas_url" >&2
  exit 2
}

echo "OK: estrutura Roku pronta para empacotamento e sideload."
