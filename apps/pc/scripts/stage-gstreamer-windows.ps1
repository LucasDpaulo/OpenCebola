<#
.SYNOPSIS
  Monta, em apps/pc/src-tauri/gstreamer-staging, o runtime do GStreamer (MSVC x86_64) que o
  instalador do Windows leva junto.

.DESCRIPTION
  O tauri.windows.conf.json mapeia esta pasta para dentro do instalador NSIS (bundle.resources):
    gstreamer-staging\bin\*.dll         -> <instalação>\                       (ao lado do .exe)
    gstreamer-staging\plugins\*.dll     -> <instalação>\gstreamer\plugins\
    gstreamer-staging\gio-modules\*.dll -> <instalação>\gstreamer\gio-modules\
    gstreamer-staging\gst-plugin-scanner.exe -> <instalação>\gstreamer\
  As DLLs de bin ficam ao lado do executável porque o exe as liga em tempo de carga
  (gstreamer-1.0-0.dll, glib-2.0-0.dll...) e o Windows só procura na pasta do aplicativo.
  O src-tauri\src\windows_native.rs aponta o GStreamer para essas pastas na inicialização.

  Rodar antes de `tauri build` (o build.rs do Tauri exige que os arquivos mapeados existam).
#>
[CmdletBinding()]
param(
    # Raiz do runtime instalado pelos MSI (a variável é gravada pelo próprio MSI).
    [string]$Root = $env:GSTREAMER_1_0_ROOT_MSVC_X86_64,
    [string]$Out = (Join-Path $PSScriptRoot '..\src-tauri\gstreamer-staging')
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { throw 'Raiz do GStreamer indefinida: informe -Root ou defina GSTREAMER_1_0_ROOT_MSVC_X86_64.' }
$Root = $Root.TrimEnd('\')
$Out = [System.IO.Path]::GetFullPath($Out).TrimEnd('\')
if ((Split-Path $Out -Leaf) -ne 'gstreamer-staging') { throw "Recuso limpar '$Out': o destino precisa se chamar gstreamer-staging." }

$binDir = Join-Path $Root 'bin'
$pluginDir = Join-Path $Root 'lib\gstreamer-1.0'
$gioDir = Join-Path $Root 'lib\gio\modules'
$scanner = Join-Path $Root 'libexec\gstreamer-1.0\gst-plugin-scanner.exe'
foreach ($path in @($binDir, $pluginDir, $scanner)) {
    if (-not (Test-Path $path)) { throw "Não encontrado no runtime do GStreamer: $path" }
}

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
$null = New-Item -ItemType Directory -Path "$Out\bin", "$Out\plugins", "$Out\gio-modules"

Copy-Item "$binDir\*.dll" "$Out\bin"
Copy-Item "$pluginDir\*.dll" "$Out\plugins"
if (Test-Path $gioDir) {
    Copy-Item "$gioDir\*.dll" "$Out\gio-modules"
}
else {
    Write-Warning "Sem módulos do GIO em ${gioDir}: https pelo souphttpsrc deve falhar."
}
Copy-Item $scanner "$Out\gst-plugin-scanner.exe"

# O runtime do Visual C++ precisa estar ao lado do exe (o próprio app em Rust e as DLLs do GStreamer
# o usam, e um Windows limpo não o tem). Se o MSI do GStreamer não o trouxe, copia do System32 do
# runner: são os mesmos binários do redistribuível, e implantação local na pasta do app é um modo
# suportado pela Microsoft.
$vcRuntime = 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll'
$vcRequired = 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'
foreach ($name in $vcRuntime) {
    $staged = Join-Path "$Out\bin" $name
    $system = Join-Path $env:windir "System32\$name"
    if (Test-Path $staged) {
        Write-Host "VC++ runtime: $name já veio com o GStreamer"
    }
    elseif (Test-Path $system) {
        Copy-Item $system $staged
        Write-Host "VC++ runtime: $name copiado do System32"
    }
    elseif ($vcRequired -contains $name) {
        throw "VC++ runtime: $name não está no GStreamer nem no System32."
    }
    else {
        Write-Host "VC++ runtime: $name ausente (opcional)"
    }
}

function Format-Size([long]$Bytes) { '{0:N1} MB' -f ($Bytes / 1MB) }

$all = Get-ChildItem $Out -Recurse -File
Write-Host ''
Write-Host "Staging em $Out"
foreach ($part in 'bin', 'plugins', 'gio-modules') {
    $files = Get-ChildItem "$Out\$part" -File
    $sum = ($files | Measure-Object Length -Sum).Sum
    Write-Host ('  {0,-12} {1,4} arquivos  {2}' -f $part, $files.Count, (Format-Size $sum))
}
Write-Host ('  TOTAL        {0,4} arquivos  {1}' -f $all.Count, (Format-Size ($all | Measure-Object Length -Sum).Sum))
Write-Host ''
Write-Host 'Maiores arquivos (candidatos a poda numa próxima rodada):'
$all | Sort-Object Length -Descending | Select-Object -First 15 | ForEach-Object {
    Write-Host ('  {0,10}  {1}' -f (Format-Size $_.Length), $_.FullName.Substring($Out.Length + 1))
}
Write-Host ''
Write-Host 'Módulos do GIO empacotados:'
Get-ChildItem "$Out\gio-modules" -File | ForEach-Object { Write-Host "  $($_.Name)" }

exit 0
