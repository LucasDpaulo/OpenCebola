#!/usr/bin/env bash
# Confere se um Next export pode ser aberto por file:// no pacote Tizen. Não o modifica.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_DIR="${1:-$ROOT/apps/web/out}"

if [ ! -d "$EXPORT_DIR" ]; then
  echo "ERRO: export Next não encontrado: $EXPORT_DIR" >&2
  echo "Gere-o fora deste script e rode novamente. Nenhum .wgt foi criado." >&2
  exit 2
fi

if [ ! -f "$EXPORT_DIR/index.html" ]; then
  echo "ERRO: $EXPORT_DIR não contém index.html; não parece um export estático do Next." >&2
  exit 2
fi

# Não usamos lookahead: o `rg` distribuído em algumas máquinas não vem com PCRE2.
# `//cdn` também é recusado: ele não é um caminho útil para um pacote aberto por file://.
ATTR_REGEX=$'(href|src|action)=["\']/'
URL_REGEX=$'url\\(["\']?/'
MATCHES="$({
  grep -r -n --include='*.html' --include='*.css' --include='*.js' --include='*.mjs' -E "$ATTR_REGEX" "$EXPORT_DIR" || true
  grep -r -n --include='*.html' --include='*.css' --include='*.js' --include='*.mjs' -E "$URL_REGEX" "$EXPORT_DIR" || true
  grep -r -n --include='*.html' --include='*.css' --include='*.js' --include='*.mjs' -F 'file://' "$EXPORT_DIR" || true
} | sort -u)"

if [ -n "$MATCHES" ]; then
  echo "ERRO: o export contém caminhos absolutos incompatíveis com file://:" >&2
  echo "$MATCHES" >&2
  echo "Este T0 não reescreve apps/web. Configure base/asset paths no trabalho T1 e exporte novamente." >&2
  exit 3
fi

echo "OK: export verificável para cópia em file://: $EXPORT_DIR"
