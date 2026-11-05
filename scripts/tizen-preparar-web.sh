#!/usr/bin/env bash
# Prepara somente os arquivos web para o diretório do pacote Tizen; não usa SDK nem cria .wgt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_DIR="${1:-$ROOT/apps/web/out}"
DESTINATION="${2:-$ROOT/apps/tizen/www/cebola}"

bash "$ROOT/scripts/tizen-verificar-export.sh" "$EXPORT_DIR"

if [ -d "$DESTINATION" ] && find "$DESTINATION" -mindepth 1 -print -quit | grep -q .; then
  echo "ERRO: destino já contém arquivos: $DESTINATION" >&2
  echo "Use um diretório de staging vazio; este script não apaga artefatos existentes." >&2
  exit 4
fi
mkdir -p "$DESTINATION"
cp -R "$EXPORT_DIR"/. "$DESTINATION"/

echo "OK: export copiado para $DESTINATION"
echo "Nenhum .wgt foi criado. SDK, certificado e empacotamento são dependências de TV/T1."
