$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
$build = Join-Path $root 'apps/pc/.native-build-windows'
$stage = Join-Path $root 'apps/pc/src-tauri/streaming-staging'
$vcpkg = $env:VCPKG_INSTALLATION_ROOT
if (-not $vcpkg) { throw 'VCPKG_INSTALLATION_ROOT ausente; use o runner Windows com vcpkg.' }
if ($env:VCPKG_DEFAULT_BINARY_CACHE) { New-Item -ItemType Directory -Path $env:VCPKG_DEFAULT_BINARY_CACHE -Force | Out-Null }

# Bibliotecas estáticas, CRT dinâmico como o restante do aplicativo MSVC.
& "$vcpkg/vcpkg.exe" install openssl:x64-windows-static-md
if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar OpenSSL.' }
$openssl = Join-Path $vcpkg 'installed/x64-windows-static-md'
cmake -S "$root/third_party/nuvio-engine" -B $build -A x64 `
  -DNUVIO_ENGINE_ENABLE_LIBTORRENT=ON -DNUVIO_ENGINE_BUILD_SHARED=OFF `
  -DNUVIO_ENGINE_BUILD_TESTS=OFF -DOPENSSL_USE_STATIC_LIBS=TRUE `
  "-DOPENSSL_ROOT_DIR=$openssl" `
  "-DCMAKE_PROJECT_nuvio_engine_INCLUDE=$root/apps/pc/native/streaming-service.cmake"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao configurar motor Windows.' }
cmake --build $build --config Release --target cebola_streaming_service --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar motor Windows.' }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item "$build/Release/cebola_streaming_service.exe" "$stage/cebola-streaming-service.exe" -Force

# Processo precisa iniciar sem DLLs do ambiente e terminar quando o app fecha stdin.
& "$PSScriptRoot/smoke-streaming-windows.ps1" -AppDir $stage
