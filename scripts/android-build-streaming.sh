#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$ROOT/third_party/nuvio-engine/platform/android"
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_HOME
if [[ -z "${JAVA_HOME:-}" && -d "$HOME/.jdks/temurin-21" ]]; then
  export JAVA_HOME="$HOME/.jdks/temurin-21"
fi
if [[ ! -d "$ANDROID_HOME/ndk/29.0.14206865" || ! -d "$ANDROID_HOME/cmake/4.1.2" ]]; then
  echo 'Instale no SDK Android: ndk;29.0.14206865 e cmake;4.1.2 antes de compilar o motor.' >&2
  exit 1
fi
export PATH="$ANDROID_HOME/cmake/4.1.2/bin:$PATH"
cd "$ENGINE"
./gradlew --no-daemon :engine:assembleRelease
mkdir -p "$ROOT/apps/app/android/app/libs"
cp engine/build/outputs/aar/engine-release.aar "$ROOT/apps/app/android/app/libs/nuvio-engine-release.aar"
echo 'AAR preparado. Compile o aplicativo com -PcebolaLocalStreaming=true.'
