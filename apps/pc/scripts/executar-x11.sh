#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DISPLAY:-}" ]]; then
  printf '%s\n' 'Cebola PC: DISPLAY ausente; inicie uma sessão gráfica antes de continuar.' >&2
  exit 2
fi

export GDK_BACKEND=x11
exec npm run dev:x11
