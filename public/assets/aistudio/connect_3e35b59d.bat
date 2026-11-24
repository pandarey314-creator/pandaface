<# :
@echo off
setlocal
title PANDAFACE + CamLink USB
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([System.IO.File]::ReadAllText('%~f0'))"
exit /b
#>

$videoPort = 7878
$ctrlPort = 7879
$studioUrl = "http://localhost:3000"

$Host.UI.RawUI.WindowTitle = "PANDAFACE + CamLink USB"
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  PANDAFACE + CamLink USB" -ForegroundColor Cyan
Write-Host "  Puerto Video: $videoPort  |  Puerto Control: $ctrlPort" -ForegroundColor Gray
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

$adbExe = (Get-Command adb -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $adbExe -and $env:LOCALAPPDATA) {
    $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdkAdb) { $adbExe = $sdkAdb }
}

$ffmpegExe = (Get-Command ffmpeg -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $ffmpegExe -and $env:LOCALAPPDATA) {
    $wingetFfmpeg = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\ffmpeg.exe"
    if (Test-Path $wingetFfmpeg) { $ffmpegExe = $wingetFfmpeg }
}

if ($adbExe) {
    Write-Host "[OK] ADB: $adbExe" -ForegroundColor Green
} else {
    Write-Host "[INFO] Modo RNDIS (Anclaje USB)" -ForegroundColor Yellow
}

if ($ffmpegExe) {
    Write-Host "[OK] FFmpeg listo" -ForegroundColor Green
} else {
    Write-Host "[INFO] Modo MJPEG directo" -ForegroundColor Yellow
}

function Get-UsbGateways {
    $ips = New-Object System.Collections.Generic.List[string]
    try {
        $configs = Get-NetIPConfiguration -ErrorAction SilentlyContinue
        foreach ($cfg in $configs) {
            if ($cfg.IPv4DefaultGateway) {
                foreach ($gw in $cfg.IPv4DefaultGateway) {
                    if ($gw.NextHop -and -not $ips.Contains($gw.NextHop)) {
                        $ips.Add($gw.NextHop)
                    }
                }
            }
        }
    } catch {}
    return $ips
}

function Probe-CamLink([string]$ip, [int]$port) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://${ip}:${port}/status")
        $req.Timeout = 450
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        return ($body | ConvertFrom-Json)
    } catch {
        return $null
    }
}

Write-Host ""
Write-Host "Abriendo PANDAFACE en $studioUrl ..." -ForegroundColor Cyan
Start-Process $studioUrl

$lastSummary = ""
while ($true) {
    $connectedLine = $null

    if ($adbExe) {
        try {
            & $adbExe forward "tcp:$videoPort" "tcp:$videoPort" 2>$null | Out-Null
            & $adbExe forward "tcp:$ctrlPort" "tcp:$ctrlPort" 2>$null | Out-Null
            $st = Probe-CamLink "127.0.0.1" $ctrlPort
            if ($st -and $st.live) {
                $connectedLine = "[CONECTADO ADB] 127.0.0.1:$videoPort ($($st.proto))"
            }
        } catch {}
    }

    $gateways = Get-UsbGateways
    if (-not $connectedLine) {
        foreach ($gw in $gateways) {
            $st = Probe-CamLink $gw $ctrlPort
            if ($st -and $st.live) {
                $connectedLine = "[CONECTADO USB] ${gw}:$videoPort ($($st.proto))"
                break
            }
        }
    }

    if ($connectedLine) {
        if ($lastSummary -ne $connectedLine) {
            Write-Host $connectedLine -ForegroundColor Green
            $lastSummary = $connectedLine
        }
    } else {
        $waitMsg = if ($gateways.Count -gt 0) {
            "[ESPERANDO] Gateways: $($gateways -join ', ')"
        } else {
            "[ESPERANDO ENLACE USB]"
        }
        if ($lastSummary -ne $waitMsg) {
            Write-Host $waitMsg -ForegroundColor DarkYellow
            $lastSummary = $waitMsg
        }
    }

    Start-Sleep -Seconds 2
}
