<#
.SYNOPSIS
  Baixa a libmpv do Windows (pacote "mpv-dev" de shinchiro, versão e SHA-256 fixos), gera o mpv.lib
  de importação para o MSVC e monta, em apps/pc/src-tauri/mpv-staging, o que o app precisa.

.DESCRIPTION
  O mpv é o motor de reserva do app no Windows (o GStreamer é o padrão). Duas coisas dependem da
  libmpv:
    - para LIGAR o app (o crate libmpv2-sys emite `cargo:rustc-link-lib=mpv`, ou seja, procura
      mpv.lib no caminho de bibliotecas do linker): mpv-staging\lib\mpv.lib;
    - para RODAR: mpv-staging\libmpv-2.dll, que o tauri.windows.conf.json leva para a pasta do
      executável (bundle.resources: mpv-staging\*.dll -> ./).

  O pacote mpv-dev traz só libmpv-2.dll, libmpv.dll.a (biblioteca de importação do MinGW, que o
  link.exe não aceita de forma confiável) e os cabeçalhos. O mpv.lib é gerado aqui: as funções
  exportadas pela DLL (todas mpv_*) saem do `dumpbin /exports`, viram um .def, e o `lib.exe` monta a
  biblioteca de importação. dumpbin e lib.exe vêm do Visual Studio instalado (vswhere), sem mexer
  no ambiente do restante do job.

  Depois de rodar, quem compila precisa enxergar a pasta do mpv.lib. O workflow faz isso:
    "RUSTFLAGS=... -L native=<...>\mpv-staging\lib" >> $GITHUB_ENV
  Localmente: $env:RUSTFLAGS = "-L native=$PWD\apps\pc\src-tauri\mpv-staging\lib".

  Rodar antes de `tauri build` (o build.rs do Tauri exige que os arquivos mapeados existam).

  Para trocar a versão: escolha um mpv-dev-x86_64-<AAAAMMDD>-git-<hash>.7z publicado em
  github.com/shinchiro/mpv-winbuild-cmake/releases (o GitHub guarda só ~30 dias) e em
  sourceforge.net/projects/mpv-player-windows/files/libmpv (guarda por mais tempo), calcule o
  SHA-256 do arquivo e atualize MPV_DEV_VERSION e MPV_DEV_SHA256 no workflow. Use a build x86_64
  comum (a x86_64-v3 exige AVX2).
#>
[CmdletBinding()]
param(
    # Ex.: 20260927-git-a1bf4b6559 (a data é também a tag da release no GitHub).
    [string]$Version = $env:MPV_DEV_VERSION,
    [string]$Sha256 = $env:MPV_DEV_SHA256,
    [string]$Out = (Join-Path $PSScriptRoot '..\src-tauri\mpv-staging')
)

$ErrorActionPreference = 'Stop'
# A barra de progresso do Invoke-WebRequest deixa o download de dezenas de MB bem mais lento.
$ProgressPreference = 'SilentlyContinue'

if (-not $Version) { throw 'Versão do mpv indefinida: informe -Version ou defina MPV_DEV_VERSION.' }
if ($Version -notmatch '^(\d{8})-git-[0-9a-f]+$') { throw "Versão inesperada: '$Version' (esperado AAAAMMDD-git-hash)." }
$tag = $Matches[1]
if (-not $Sha256) { throw 'SHA-256 do mpv indefinido: informe -Sha256 ou defina MPV_DEV_SHA256.' }
$Sha256 = $Sha256.Trim().ToUpperInvariant()
if ($Sha256 -notmatch '^[0-9A-F]{64}$') { throw "SHA-256 inválido: '$Sha256'." }

$Out = [System.IO.Path]::GetFullPath($Out).TrimEnd('\')
if ((Split-Path $Out -Leaf) -ne 'mpv-staging') { throw "Recuso limpar '$Out': o destino precisa se chamar mpv-staging." }

$scratch = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$work = Join-Path $scratch 'cebola-mpv-dev'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
$null = New-Item -ItemType Directory -Path $work

# Mesmo arquivo nas duas origens; a segunda cobre o dia em que o GitHub já tiver apagado a release.
$name = "mpv-dev-x86_64-$Version.7z"
$sources = @(
    "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$tag/$name",
    "https://downloads.sourceforge.net/project/mpv-player-windows/libmpv/$name"
)

$archive = Join-Path $work $name
$verified = $false
foreach ($url in $sources) {
    try {
        Write-Host "Baixando $url"
        Invoke-WebRequest -Uri $url -OutFile $archive -MaximumRetryCount 3 -RetryIntervalSec 5
        $actual = (Get-FileHash $archive -Algorithm SHA256).Hash
        if ($actual -eq $Sha256) { $verified = $true; break }
        Write-Warning "SHA-256 de $name não confere nesta origem (obtido $actual)."
    }
    catch {
        Write-Warning "Falha ao baixar de ${url}: $($_.Exception.Message)"
    }
}
if (-not $verified) { throw "Não foi possível obter $name com o SHA-256 esperado ($Sha256)." }
Write-Host "SHA-256 conferido: $Sha256"

# 7-Zip já vem no runner do GitHub; o .7z não é lido pelo Expand-Archive.
$sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source
if (-not $sevenZip) {
    $sevenZip = @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $sevenZip) { throw '7-Zip não encontrado: ele é necessário para abrir o pacote .7z da libmpv.' }

$extracted = Join-Path $work 'extracted'
& $sevenZip x -y "-o$extracted" $archive 'libmpv-2.dll' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7-Zip falhou ao extrair $name (código $LASTEXITCODE)." }
$dll = Join-Path $extracted 'libmpv-2.dll'
if (-not (Test-Path $dll)) { throw "libmpv-2.dll não está em $name." }

# --- mpv.lib para o MSVC -------------------------------------------------------------------------

function Find-MsvcTool([string]$Tool) {
    # Dentro de um Developer Prompt a ferramenta já está no PATH.
    $found = (Get-Command $Tool -ErrorAction SilentlyContinue).Source
    if ($found) { return $found }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw "vswhere.exe não encontrado: sem Visual Studio, não há $Tool." }
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw "Visual Studio com as ferramentas C++ x64 não encontrado (precisa de $Tool)." }
    $found = Get-ChildItem (Join-Path ($vs | Select-Object -First 1) 'VC\Tools\MSVC') -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "bin\Hostx64\x64\$Tool" } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $found) { throw "$Tool não encontrado no Visual Studio ($vs)." }
    return $found
}

# Saída do `dumpbin /exports`: linhas "ordinal hint RVA nome" (as exportações só por ordinal, sem
# nome, não têm a quarta coluna e ficam de fora). A DLL também exporta símbolos do libbluray (JNI);
# a libmpv2-sys usa só as funções do cliente, todas mpv_*.
function ConvertTo-MpvDef([string[]]$DumpbinOutput) {
    $names = foreach ($line in $DumpbinOutput) {
        if ($line -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(mpv_\w+)\s*$') { $Matches[1] }
    }
    $names = @($names | Sort-Object -Unique)
    foreach ($required in 'mpv_create', 'mpv_initialize', 'mpv_command', 'mpv_wait_event', 'mpv_client_api_version') {
        if ($names -notcontains $required) { throw "A DLL não exporta ${required}: o dumpbin mudou de formato ou a DLL é outra." }
    }
    @('LIBRARY libmpv-2.dll', 'EXPORTS') + $names
}

$dumpbin = Find-MsvcTool 'dumpbin.exe'
$libTool = Find-MsvcTool 'lib.exe'
Write-Host "dumpbin: $dumpbin"
Write-Host "lib:     $libTool"

$dump = & $dumpbin /nologo /exports $dll
if ($LASTEXITCODE -ne 0) { throw "dumpbin falhou (código $LASTEXITCODE)." }
$def = Join-Path $work 'mpv.def'
$defLines = ConvertTo-MpvDef ($dump -split "`r?`n")
Set-Content -Path $def -Value $defLines -Encoding ascii
Write-Host ("Exportações mpv_* da DLL: {0}" -f ($defLines.Count - 2))

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
$null = New-Item -ItemType Directory -Path "$Out\lib"
$importLib = Join-Path "$Out\lib" 'mpv.lib'
& $libTool /nologo "/def:$def" /machine:x64 "/out:$importLib"
if ($LASTEXITCODE -ne 0) { throw "lib.exe falhou (código $LASTEXITCODE)." }
if (-not (Test-Path $importLib)) { throw 'lib.exe não gerou o mpv.lib.' }

# Só o .lib interessa ao linker; o .exp que o lib.exe deixa ao lado não.
Remove-Item (Join-Path "$Out\lib" 'mpv.exp') -ErrorAction SilentlyContinue
Copy-Item $dll "$Out\libmpv-2.dll"

function Format-Size([long]$Bytes) { '{0:N1} MB' -f ($Bytes / 1MB) }
Write-Host ''
Write-Host "Staging em $Out (mpv-dev $Version)"
foreach ($file in "$Out\libmpv-2.dll", $importLib) {
    Write-Host ('  {0,10}  {1}' -f (Format-Size (Get-Item $file).Length), $file.Substring($Out.Length + 1))
}
Write-Host ''
Write-Host 'Para o linker achar o mpv.lib, aponte o rustc para a pasta (o workflow já faz isto):'
Write-Host "  RUSTFLAGS = -L native=$Out\lib"

exit 0
