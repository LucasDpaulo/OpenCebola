<#
.SYNOPSIS
  Confere se o GStreamer empacotado funciona sozinho, sem o GStreamer instalado no runner.

.DESCRIPTION
  Reproduz o que o windows_native.rs faz na inicialização do app (mantenha os dois em sincronia):
  variáveis de ambiente só para a pasta do aplicativo, registro novo e PATH sem o GStreamer do
  runner. O gst-inspect-1.0.exe e o gst-launch-1.0.exe do runtime instalado entram apenas como
  ferramentas: são copiados para a pasta do aplicativo, então carregam as DLLs dali.

  Duas formas de uso:
    -Staging <pasta>  monta uma "instalação" simulada em %RUNNER_TEMP% a partir do gstreamer-staging
                      (antes do build; falha cedo se o pacote estiver incompleto).
    -AppDir <pasta>   confere uma instalação de verdade, feita pelo instalador NSIS.
#>
[CmdletBinding()]
param(
    # Raiz do GStreamer instalado no runner; usada só para pegar as ferramentas de linha de comando.
    [string]$Root = $env:GSTREAMER_1_0_ROOT_MSVC_X86_64,
    [string]$Staging,
    [string]$AppDir
)

$ErrorActionPreference = 'Stop'

if ([bool]$Staging -eq [bool]$AppDir) { throw 'Informe exatamente um entre -Staging e -AppDir.' }
if (-not $Root) { throw 'Raiz do GStreamer indefinida: informe -Root ou defina GSTREAMER_1_0_ROOT_MSVC_X86_64.' }
$Root = $Root.TrimEnd('\')
$scratch = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }

if ($Staging) {
    $Staging = (Resolve-Path $Staging).Path
    $AppDir = Join-Path $scratch 'cebola-smoke-app'
    if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
    $null = New-Item -ItemType Directory -Path "$AppDir\gstreamer\plugins", "$AppDir\gstreamer\gio-modules"
    # Mesma disposição que o instalador cria (ver tauri.windows.conf.json).
    Copy-Item "$Staging\bin\*.dll" $AppDir
    Copy-Item "$Staging\plugins\*.dll" "$AppDir\gstreamer\plugins"
    Copy-Item "$Staging\gio-modules\*.dll" "$AppDir\gstreamer\gio-modules" -ErrorAction SilentlyContinue
    Copy-Item "$Staging\gst-plugin-scanner.exe" "$AppDir\gstreamer"
}
$AppDir = (Resolve-Path $AppDir).Path

foreach ($tool in 'gst-inspect-1.0.exe', 'gst-launch-1.0.exe') {
    Copy-Item (Join-Path $Root "bin\$tool") $AppDir -Force
}
$inspect = Join-Path $AppDir 'gst-inspect-1.0.exe'
$launch = Join-Path $AppDir 'gst-launch-1.0.exe'

# Ambiente isolado: sem o GStreamer do runner no PATH nem variáveis GST_*/GIO_* herdadas.
$runnerBin = Join-Path $Root 'bin'
$env:Path = (($env:Path -split ';') | Where-Object {
        $_ -and ($_.TrimEnd('\') -ne $runnerBin) -and ($_ -notmatch 'gstreamer')
    }) -join ';'
Get-ChildItem Env: | Where-Object { $_.Name -like 'GST_*' -or $_.Name -like 'GIO_*' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" }

$plugins = Join-Path $AppDir 'gstreamer\plugins'
$env:GST_PLUGIN_SYSTEM_PATH_1_0 = $plugins
$env:GST_PLUGIN_PATH_1_0 = $plugins
$env:GST_PLUGIN_PATH = $plugins
$env:GST_PLUGIN_SCANNER_1_0 = Join-Path $AppDir 'gstreamer\gst-plugin-scanner.exe'
$env:GST_PLUGIN_SCANNER = $env:GST_PLUGIN_SCANNER_1_0
$env:GIO_MODULE_DIR = Join-Path $AppDir 'gstreamer\gio-modules'
$env:GST_REGISTRY_1_0 = Join-Path $scratch 'cebola-smoke-registry.bin'
if (Test-Path $env:GST_REGISTRY_1_0) { Remove-Item $env:GST_REGISTRY_1_0 -Force }
$env:Path = "$AppDir;$env:Path"

function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    # Avisos no stderr não podem virar erro terminante do PowerShell.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $text = (& $Exe @Arguments 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $saved }
    [pscustomobject]@{ Code = $LASTEXITCODE; Output = $text }
}

Write-Host "Pasta do aplicativo: $AppDir"
$version = Invoke-Native $inspect @('--version')
Write-Host ($version.Output.Trim())

# A primeira chamada varre os plugins com o scanner empacotado e cria o registro.
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$first = Invoke-Native $inspect @('playbin3')
Write-Host ('Primeira varredura de plugins: {0:N0} s' -f $timer.Elapsed.TotalSeconds)
if ($first.Code -ne 0) { Write-Host $first.Output }

$missing = [System.Collections.Generic.List[string]]::new()
function Test-Element {
    param([string]$Name)
    $result = Invoke-Native $inspect @($Name)
    if ($result.Code -eq 0) { Write-Host "OK      $Name" }
    return ($result.Code -eq 0)
}

$required = 'playbin3', 'souphttpsrc', 'matroskademux', 'qtdemux', 'avdec_h264', 'avdec_h265',
'avdec_aac', 'avdec_ac3', 'avdec_eac3', 'subparse'
foreach ($name in $required) {
    if (-not (Test-Element $name)) { Write-Host "FALTA   $name"; $missing.Add($name) }
}

# O d3d11videosink só é registrado se o D3D11 enxergar um adaptador, e o runner não tem GPU. Se o
# elemento não aparece mas o plugin carrega, o pacote está certo e o que falta é hardware.
if (-not (Test-Element 'd3d11videosink')) {
    $pluginLoads = (Test-Path "$plugins\gstd3d11.dll") -and ((Invoke-Native $inspect @('d3d11')).Code -eq 0)
    if ($pluginLoads) {
        Write-Warning 'd3d11videosink não registrado, mas o plugin d3d11 carrega (provável falta de GPU no runner).'
    }
    else {
        Write-Host 'FALTA   d3d11videosink (plugin d3d11 ausente ou não carrega)'
        $missing.Add('d3d11videosink')
    }
}

if (-not ((Test-Element 'wasapi2sink') -or (Test-Element 'wasapisink'))) {
    Write-Host 'FALTA   wasapi2sink/wasapisink'
    $missing.Add('wasapi2sink|wasapisink')
}

if (-not (Test-Element 'assrender')) {
    Write-Warning 'assrender ausente: legendas ASS não serão desenhadas pelo GStreamer.'
}

Write-Host ''
Write-Host 'Plugins na lista negra do scanner (deve estar vazio ou conter só o que não importa):'
Write-Host ((Invoke-Native $inspect @('-b')).Output.Trim())
Write-Host 'Resumo do registro:'
(Invoke-Native $inspect @()).Output -split "`r?`n" | Where-Object { $_ -match '^Total count' } | ForEach-Object { Write-Host $_ }

# https depende do módulo TLS do GIO (glib-networking). Rede instável não deve derrubar o build,
# então só avisa; o log mostra o motivo.
$tls = Invoke-Native $launch @('-q', 'souphttpsrc', 'location=https://valid-isrgrootx1.letsencrypt.org/', 'num-buffers=1', '!', 'fakesink')
if ($tls.Code -eq 0) {
    Write-Host 'OK      https pelo souphttpsrc (TLS)'
}
else {
    Write-Warning "https pelo souphttpsrc falhou (código $($tls.Code)). Saída:`n$($tls.Output)"
}

if ($missing.Count -gt 0) {
    throw "Elementos obrigatórios ausentes no GStreamer empacotado: $($missing -join ', ')"
}
Write-Host 'GStreamer empacotado: todos os elementos obrigatórios presentes.'
exit 0
