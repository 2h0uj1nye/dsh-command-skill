$ErrorActionPreference = 'Continue'
$log = 'C:\Users\Administrator\Documents\dsh-command-skill\restart.log'
"=== dsh web restart (command-skill install) at $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

# Let the agent turn finish delivering its answer before the harness dies.
Start-Sleep -Seconds 25

# Kill whatever process is listening on 3080 (the running dsh web server).
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $pid3080 = $conn | Select-Object -First 1 -ExpandProperty OwningProcess
    "killing pid $pid3080 (listener on 3080)" | Out-File $log -Append -Encoding utf8
    Stop-Process -Id $pid3080 -Force -ErrorAction SilentlyContinue
} else {
    "no listener on 3080" | Out-File $log -Append -Encoding utf8
}
Start-Sleep -Seconds 3

# Wait until port 3080 is free.
for ($i = 0; $i -lt 20; $i++) {
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { break }
    Start-Sleep -Seconds 1
}

# Start the new web server detached, same command as the original launch.
$node = 'C:\Program Files\nodejs\node.exe'
$bin  = 'D:\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$out  = 'C:\Users\Administrator\Documents\dsh-gui.stdout.log'
$err  = 'C:\Users\Administrator\Documents\dsh-gui.stderr.log'
$p = Start-Process -FilePath $node -ArgumentList @($bin, 'web') `
    -WorkingDirectory 'C:\Users\Administrator\Documents' `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
"started new server pid: $($p.Id)" | Out-File $log -Append -Encoding utf8

Start-Sleep -Seconds 12
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080' -TimeoutSec 15
    "http check: status $($r.StatusCode)" | Out-File $log -Append -Encoding utf8
} catch {
    "http check failed: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
}
"done at $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
