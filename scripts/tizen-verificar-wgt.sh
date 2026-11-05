#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 && -f "$1" ]] || { echo "ERRO: informe um .wgt existente" >&2; exit 2; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unzip -t "$1" >/dev/null
entries="$(unzip -Z1 "$1")"
if [[ -n "$(sort <<<"$entries" | uniq -d)" ]]; then
  echo "ERRO: pacote Tizen contém entrada ZIP duplicada" >&2
  exit 2
fi
for required in config.xml author-signature.xml signature1.xml www/index.html; do
  rg -qx "$required" <<<"$entries" >/dev/null || {
    echo "ERRO: pacote Tizen sem $required" >&2
    exit 2
  }
done
if rg -i '\.(p12|pfx|pem|key|jks)$|(^|/)(profiles\.xml|credentials|secrets?)(/|$)' <<<"$entries" >/dev/null; then
  echo "ERRO: possível material secreto dentro do .wgt" >&2
  exit 3
fi
expected_id="${CEBOLA_TIZEN_EXPECTED_APP_ID:-CEBOLA0001.CebolaTV}"
python3 "$script_dir/tizen-verificar-wgt.py" "$1" "$expected_id"
echo "OK: estrutura do WGT e CRC válidos; assinatura criptográfica não verificada"
