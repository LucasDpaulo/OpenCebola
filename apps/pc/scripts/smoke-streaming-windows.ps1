param([Parameter(Mandatory = $true)][string]$AppDir)
$ErrorActionPreference = 'Stop'
$exe = Join-Path (Resolve-Path $AppDir).Path 'cebola-streaming-service.exe'
if (-not (Test-Path $exe)) { throw 'Motor local ausente.' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('cebola-streaming-' + [Guid]::NewGuid())
$info = [Diagnostics.ProcessStartInfo]::new($exe)
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.Environment['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
foreach ($argument in @($temp, '17f34a295ce6b870943acdee129f56b7206c492e', '-1', '')) {
  $info.ArgumentList.Add($argument)
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
try {
  if (-not $process.Start()) { throw 'Motor não iniciou.' }
  $out = $process.StandardOutput.ReadToEndAsync()
  $err = $process.StandardError.ReadToEndAsync()
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { throw "Motor encerrou antes do cancelamento: $($err.Result)" }
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(10000)) { throw 'Motor não encerrou após EOF.' }
  if (Test-Path $temp) { throw 'Motor deixou arquivos temporários após cancelamento.' }
  Write-Host 'Motor Windows: início, cancelamento por EOF e limpeza aprovados.'
} finally {
  if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  $process.Dispose()
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
}
