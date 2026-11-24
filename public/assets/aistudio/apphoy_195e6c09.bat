<# :
@echo off
title CamLink USB - Auto-Lanzador PC
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([System.IO.File]::ReadAllText('%~f0'))"
exit /b
#>

$tcpPort = 7878
$ctrlPort = 7879
$udpPort = 7879
$defaultCodec = "h264"

$Host.UI.RawUI.WindowTitle = "CamLink USB - Esperando movil..."
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  CamLink USB - Auto-Lanzador en PC" -ForegroundColor Cyan
Write-Host "  Puerto Video: $tcpPort | Control: $ctrlPort | UDP: $udpPort" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan

$adbExe = (Get-Command adb -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $adbExe) {
    $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdkAdb) { $adbExe = $sdkAdb }
}
$ffplayExe = (Get-Command ffplay -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
$vlcExe = (Get-Command vlc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
$edgeExe = (Get-Command msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $edgeExe) {
    $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if (Test-Path $edgePath) { $edgeExe = $edgePath }
}
$chromeExe = (Get-Command chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $chromeExe) {
    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (Test-Path $chromePath) { $chromeExe = $chromePath }
}

if ($ffplayExe) { Write-Host "[OK] ffplay detectado (modo H.264/HEVC baja latencia)." -ForegroundColor Green }
elseif ($vlcExe) { Write-Host "[OK] VLC detectado." -ForegroundColor Green }
elseif ($edgeExe -or $chromeExe) { Write-Host "[OK] Navegador detectado (auto-cambiara a MJPEG si no hay ffplay)." -ForegroundColor Green }

if ($adbExe) { Write-Host "[OK] ADB detectado: $adbExe" -ForegroundColor Green }
else { Write-Host "[INFO] Sin ADB: usando deteccion USB Tethering / red local." -ForegroundColor Yellow }

Write-Host ""
Write-Host "1) Conecta el cable USB al movil." -ForegroundColor White
Write-Host "2) Activa 'Anclaje USB' (Tethering) o 'Depuracion USB' (ADB)." -ForegroundColor White
Write-Host "3) Abre CamLink USB y pulsa 'Transmitir' (o activa Auto-transmitir)." -ForegroundColor White
Write-Host ""

function Get-AdbDeviceSerials([string]$adbPath) {
    $serials = New-Object System.Collections.Generic.List[string]
    if (-not $adbPath) { return $serials }
    try {
        $lines = & $adbPath devices 2>$null
        foreach ($line in $lines) {
            if ($line -match '^([^\s]+)\s+device\s*$') {
                $serials.Add($Matches[1])
            }
        }
    } catch {}
    return $serials
}

function Get-CandidatePhoneIps {
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

function Probe-ControlStatus([string]$ip, [int]$cPort) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://${ip}:${cPort}/status")
        $req.Timeout = 350
        $req.ReadWriteTimeout = 350
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $json = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        return ($json | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Request-MjpegMode([string]$ip, [int]$cPort) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://${ip}:${cPort}/use-mjpeg")
        $req.Timeout = 800
        $resp = $req.GetResponse()
        $resp.Close()
        Start-Sleep -Milliseconds 350
        return $true
    } catch {
        return $false
    }
}

function Open-CamWindow([string]$hostIp, [int]$port, [string]$proto, [int]$cPort) {
    $codec = if ($proto -eq "HEVC_TCP") { "hevc" } elseif ($proto -eq "MJPEG_HTTP") { "mjpeg" } else { "h264" }

    if ($codec -ne "mjpeg" -and -not $ffplayExe -and -not $vlcExe) {
        Write-Host "[INFO] Sin ffplay/VLC para H.264 -> activando modo MJPEG compatible en el movil..." -ForegroundColor Yellow
        if (Request-MjpegMode $hostIp $cPort) {
            $codec = "mjpeg"
        }
    }

    if ($codec -eq "mjpeg") {
        $streamUrl = "http://${hostIp}:${port}/video"
        $monitorUrl = "http://${hostIp}:${port}/monitor"
        if ($ffplayExe) {
            $p = Start-Process -PassThru $ffplayExe -ArgumentList @(
                "-window_title", "CamLink USB Live",
                "-fflags", "nobuffer", "-flags", "low_delay", "-framedrop",
                "-f", "mpjpeg", $streamUrl
            )
            return @{ proc = $p; isBrowser = $false }
        }
        if ($edgeExe) {
            $p = Start-Process -PassThru $edgeExe -ArgumentList @("--new-window", "--app=$monitorUrl")
            return @{ proc = $p; isBrowser = $true }
        }
        if ($chromeExe) {
            $p = Start-Process -PassThru $chromeExe -ArgumentList @("--new-window", "--app=$monitorUrl")
            return @{ proc = $p; isBrowser = $true }
        }
        $p = Start-Process -PassThru $monitorUrl
        return @{ proc = $p; isBrowser = $true }
    } else {
        $tcpUrl = "tcp://${hostIp}:${port}"
        if ($ffplayExe) {
            $p = Start-Process -PassThru $ffplayExe -ArgumentList @(
                "-window_title", "CamLink USB Live",
                "-fflags", "nobuffer", "-flags", "low_delay", "-framedrop",
                "-probesize", "32", "-analyzeduration", "0",
                "-f", $codec, $tcpUrl
            )
            return @{ proc = $p; isBrowser = $false }
        }
        if ($vlcExe) {
            $p = Start-Process -PassThru $vlcExe -ArgumentList @(
                "--demux=$codec", "--network-caching=0", $tcpUrl
            )
            return @{ proc = $p; isBrowser = $false }
        }
        return $null
    }
}

$udp = New-Object System.Net.Sockets.UdpClient(0)
$udp.EnableBroadcast = $true
$udp.Client.ReceiveTimeout = 250
$remoteEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)

$viewerProc = $null
$viewerIsBrowser = $false
$activeKey = ""
$lastStatusTime = [DateTime]::MinValue
$missCount = 0

while ($true) {
    if ($viewerProc -and -not $viewerIsBrowser -and $viewerProc.HasExited) {
        $viewerProc = $null
        $activeKey = ""
    }

    $foundIp = $null
    $foundPort = $tcpPort
    $foundProto = $null
    $standbyDevice = $null

    # 1. Try ADB loopback first if adb.exe detects an authorized device
    $adbSerials = Get-AdbDeviceSerials $adbExe
    foreach ($serial in $adbSerials) {
        try {
            & $adbExe -s $serial forward "tcp:$tcpPort" "tcp:$tcpPort" 2>$null | Out-Null
            & $adbExe -s $serial forward "tcp:$ctrlPort" "tcp:$ctrlPort" 2>$null | Out-Null
            $st = Probe-ControlStatus "127.0.0.1" $ctrlPort
            if ($st) {
                if ($st.live) {
                    $foundIp = "127.0.0.1"
                    $foundPort = [int]$st.port
                    $foundProto = [string]$st.proto
                    break
                } else {
                    $standbyDevice = "$($st.device) (ADB $serial)"
                }
            }
        } catch {}
    }

    # 2. Probe active USB Tethering / local Gateway IPs directly via HTTP TCP (firewall-proof)
    $gateways = Get-CandidatePhoneIps
    if (-not $foundIp) {
        foreach ($gwIp in $gateways) {
            $st = Probe-ControlStatus $gwIp $ctrlPort
            if ($st) {
                if ($st.live) {
                    $foundIp = $gwIp
                    $foundPort = [int]$st.port
                    $foundProto = [string]$st.proto
                    break
                } elseif (-not $standbyDevice) {
                    $standbyDevice = "$($st.device) ($gwIp)"
                }
            }
        }
    }

    # 3. Send outbound UDP discovery burst (pierces Windows Firewall for reply)
    if (-not $foundIp) {
        try {
            $whoBytes = [System.Text.Encoding]::UTF8.GetBytes("CAMLINK_WHO")
            $bcastEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Broadcast, $udpPort)
            $null = $udp.Send($whoBytes, $whoBytes.Length, $bcastEp)
            $replyBytes = $udp.Receive([ref]$remoteEp)
            $msg = [System.Text.Encoding]::UTF8.GetString($replyBytes)
            if ($msg.StartsWith("CAMLINK_LIVE") -or $msg.StartsWith("CAMLINK_READY")) {
                $kv = @{}
                foreach ($part in $msg.Split("|")) {
                    if ($part -match "=") {
                        $pair = $part.Split("=", 2)
                        $kv[$pair[0]] = $pair[1]
                    }
                }
                $replyIp = if ($kv["ip"] -and $kv["ip"] -ne "127.0.0.1") { $kv["ip"] } else { $remoteEp.Address.IPAddressToString }
                if ($msg.StartsWith("CAMLINK_LIVE")) {
                    $foundIp = $replyIp
                    if ($kv["port"]) { $foundPort = [int]$kv["port"] }
                    $foundProto = if ($kv["proto"]) { $kv["proto"] } else { "H264_TCP" }
                } elseif (-not $standbyDevice) {
                    $standbyDevice = "$($kv['device']) ($replyIp)"
                }
            }
        } catch {}
    }

    if ($foundIp) {
        $missCount = 0
        $key = "${foundIp}:${foundPort}"
        if ($activeKey -ne $key) {
            Write-Host "[EN VIVO] Movil conectado en $key ($foundProto). Abriendo pantalla..." -ForegroundColor Green
            $res = Open-CamWindow $foundIp $foundPort $foundProto $ctrlPort
            if ($res) {
                $viewerProc = $res.proc
                $viewerIsBrowser = $res.isBrowser
                $activeKey = $key
            }
        }
    } else {
        if ($activeKey -ne "") {
            $missCount++
            if ($missCount -ge 4) {
                Write-Host "[INFO] Transmision detenida. Esperando nueva conexion..." -ForegroundColor Yellow
                $activeKey = ""
                $viewerProc = $null
                $viewerIsBrowser = $false
                $missCount = 0
            }
        }

        $now = Get-Date
        if (($now - $lastStatusTime).TotalSeconds -ge 4 -and $activeKey -eq "") {
            $lastStatusTime = $now
            if ($standbyDevice) {
                Write-Host "[DETECTADO] $standbyDevice en espera. Pulsa 'Transmitir' en el movil..." -ForegroundColor Cyan
            } elseif ($gateways.Count -eq 0 -and $adbSerials.Count -eq 0) {
                Write-Host "[Esperando enlace USB...] No hay 'Anclaje USB' ni ADB activo aun." -ForegroundColor DarkYellow
            } else {
                Write-Host "[Listo] Buscando transmision activa en: $($gateways -join ', ') ..." -ForegroundColor DarkGray
            }
        }
    }

    Start-Sleep -Milliseconds 450
}
