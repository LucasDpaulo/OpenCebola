#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${CEBOLA_ENGINE_BUILD_DIR:-$ROOT/apps/pc/.native-build}"
DEST="${1:-$ROOT/../cebola-linux}"
CMAKE_BIN="${CEBOLA_CMAKE:-cmake}"
if ! command -v "$CMAKE_BIN" >/dev/null && [[ -x "${ANDROID_HOME:-$HOME/Android/Sdk}/cmake/4.1.2/bin/cmake" ]]; then
  export PATH="${ANDROID_HOME:-$HOME/Android/Sdk}/cmake/4.1.2/bin:$PATH"
fi
"$CMAKE_BIN" -S "$ROOT/third_party/nuvio-engine" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DNUVIO_ENGINE_ENABLE_LIBTORRENT=ON \
  -DNUVIO_ENGINE_BUILD_SHARED=OFF -DNUVIO_ENGINE_BUILD_TESTS=OFF \
  -DCMAKE_PROJECT_nuvio_engine_INCLUDE="$ROOT/apps/pc/native/streaming-service.cmake"
"$CMAKE_BIN" --build "$BUILD" --target cebola_streaming_service --parallel "${CEBOLA_BUILD_JOBS:-4}"
cd "$ROOT"
npm run build:web --workspace=@cebola/pc
CARGO_BUILD_JOBS="${CEBOLA_BUILD_JOBS:-4}" cargo build --manifest-path apps/pc/src-tauri/Cargo.toml --locked --features tauri/custom-protocol
mkdir -p "$DEST"
install -m 755 apps/pc/src-tauri/target/debug/cebola-pc "$DEST/cebola-pc.new"
install -m 755 "$BUILD/cebola_streaming_service" "$DEST/cebola-streaming-service.new"
mv "$DEST/cebola-pc.new" "$DEST/cebola-pc"
mv "$DEST/cebola-streaming-service.new" "$DEST/cebola-streaming-service"
cat > "$DEST/abrir.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export GDK_BACKEND="${GDK_BACKEND:-x11}"
exec "$APP_DIR/cebola-pc" "$@"
LAUNCH
chmod +x "$DEST/abrir.sh"
echo "Abra pelo terminal: $DEST/abrir.sh"
