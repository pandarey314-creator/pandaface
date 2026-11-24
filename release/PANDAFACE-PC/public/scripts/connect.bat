<# :
@echo off
setlocal
title PANDAFACE + CamLink USB
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([System.IO.File]::ReadAllText('%~f0'))"
exit /b
#>

$videoPort = 7878
$ctrlPort = 7879
$udpPort = 7879
$studioUrl = "http://localhost:3000"

$Host.UI.RawUI.WindowTitle = "PANDAFACE + CamLink USB"
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  PANDAFACE + CamLink USB (Puente Automatico)" -ForegroundColor Cyan
Write-Host "  Video: $videoPort  |  Control/UDP: $ctrlPort" -ForegroundColor Gray
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
if (-not $ffmpegExe -and (Test-Path "C:\ffmpeg\bin\ffmpeg.exe")) {
    $ffmpegExe = "C:\ffmpeg\bin\ffmpeg.exe"
}

if ($adbExe) {
    Write-Host "[OK] ADB: $adbExe" -ForegroundColor Green
} else {
    Write-Host "[INFO] Sin ADB: usando deteccion Anclaje USB (RNDIS/NCM) + UDP" -ForegroundColor Yellow
}

if ($ffmpegExe) {
    Write-Host "[OK] FFmpeg listo: $ffmpegExe" -ForegroundColor Green
} else {
    Write-Host "[INFO] Sin FFmpeg: PANDAFACE usara modo MJPEG directo" -ForegroundColor Yellow
}

function Test-PrivateIpv4([string]$ip) {
    if (-not $ip) { return $false }
    if ($ip -eq "127.0.0.1") { return $true }
    if ($ip -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $false }
    $parts = $ip.Split('.') | ForEach-Object { [int]$_ }
    if ($parts[0] -eq 10) { return $true }
    if ($parts[0] -eq 192 -and $parts[1] -eq 168) { return $true }
    if ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) { return $true }
    return $false
}

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
    $addIp = {
        param([string]$candidate)
        if ($candidate -and $candidate -ne "127.0.0.1" -and -not $candidate.EndsWith(".255") -and -not $candidate.EndsWith(".0") -and (Test-PrivateIpv4 $candidate)) {
            if (-not $ips.Contains($candidate)) {
                $ips.Add($candidate)
            }
        }
    }

    try {
        $configs = Get-NetIPConfiguration -ErrorAction SilentlyContinue
        foreach ($cfg in $configs) {
            if ($cfg.IPv4DefaultGateway) {
                foreach ($gw in $cfg.IPv4DefaultGateway) {
                    & $addIp $gw.NextHop
                }
            }
        }
    } catch {}

    try {
        $wmi = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" -ErrorAction SilentlyContinue
        foreach ($nic in $wmi) {
            if ($nic.DHCPServer) { & $addIp $nic.DHCPServer }
            if ($nic.DefaultIPGateway) {
                foreach ($dgw in $nic.DefaultIPGateway) { & $addIp $dgw }
            }
        }
    } catch {}

    try {
        $neighbors = Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.State -in @("Reachable", "Stale", "Delay", "Probe", "Permanent") }
        foreach ($n in $neighbors) { & $addIp $n.IPAddress }
    } catch {}

    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -ne "127.0.0.1" -and (Test-PrivateIpv4 $_.IPAddress) }
        foreach ($a in $addrs) {
            $octets = $a.IPAddress.Split('.')
            if ($octets.Length -eq 4) {
                $prefix = "$($octets[0]).$($octets[1]).$($octets[2])"
                & $addIp "$prefix.1"
                & $addIp "$prefix.129"
            }
        }
    } catch {}

    return $ips
}

function Get-LocalBroadcastPairs {
    $pairs = New-Object System.Collections.Generic.List[hashtable]
    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -ne "127.0.0.1" -and (Test-PrivateIpv4 $_.IPAddress) }
        foreach ($a in $addrs) {
            if ($a.PrefixLength -ge 8 -and $a.PrefixLength -le 30) {
                $bytes = ([System.Net.IPAddress]::Parse($a.IPAddress)).GetAddressBytes()
                [Array]::Reverse($bytes)
                $ipInt = [uint64][BitConverter]::ToUInt32($bytes, 0)
                $maskInt = ([uint64]0xFFFFFFFF -shl (32 - $a.PrefixLength)) -band [uint64]0xFFFFFFFF
                $invMask = ([uint64]0xFFFFFFFF) -bxor $maskInt
                $bcastInt = [uint32](($ipInt -band $maskInt) -bor $invMask)
                $bcastBytes = [BitConverter]::GetBytes($bcastInt)
                [Array]::Reverse($bcastBytes)
                $bcastIp = ([System.Net.IPAddress]::new($bcastBytes)).ToString()
                $pairs.Add(@{ localIp = $a.IPAddress; broadcastIp = $bcastIp })
            }
        }
    } catch {}
    if ($pairs.Count -eq 0) {
        $pairs.Add(@{ localIp = $null; broadcastIp = "255.255.255.255" })
    }
    return $pairs
}

function Probe-UdpCamLink([int]$targetUdpPort) {
    $whoBytes = [System.Text.Encoding]::UTF8.GetBytes("CAMLINK_WHO")
    foreach ($pair in (Get-LocalBroadcastPairs)) {
        $sock = $null
        try {
            if ($pair.localIp) {
                $localEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($pair.localIp), 0)
                $sock = New-Object System.Net.Sockets.UdpClient($localEp)
            } else {
                $sock = New-Object System.Net.Sockets.UdpClient(0)
            }
            $sock.EnableBroadcast = $true
            $sock.Client.ReceiveTimeout = 220

            $targets = @($pair.broadcastIp, "255.255.255.255") | Select-Object -Unique
            foreach ($bcastIp in $targets) {
                $bcastEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($bcastIp), $targetUdpPort)
                $null = $sock.Send($whoBytes, $whoBytes.Length, $bcastEp)
            }

            $remoteEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
            $replyBytes = $sock.Receive([ref]$remoteEp)
            $msg = [System.Text.Encoding]::UTF8.GetString($replyBytes)
            if ($msg.StartsWith("CAMLINK_LIVE") -or $msg.StartsWith("CAMLINK_READY")) {
                return @{
                    message = $msg
                    remoteIp = $remoteEp.Address.IPAddressToString
                }
            }
        } catch {
        } finally {
            if ($sock) { $sock.Close() }
        }
    }
    return $null
}

function Probe-CamLink([string]$ip, [int]$port) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://${ip}:${port}/status")
        $req.Timeout = 400
        $req.ReadWriteTimeout = 400
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

function Test-PandafaceLocalServer {
    try {
        $req = [System.Net.HttpWebRequest]::Create("$studioUrl/api/health")
        $req.Timeout = 800
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        return $false
    }
}

function Notify-Pandaface([hashtable]$payload) {
    try {
        $json = $payload | ConvertTo-Json -Depth 4 -Compress
        Invoke-RestMethod -Uri "$studioUrl/api/usb-cam/register" -Method Post -ContentType "application/json" -Body $json -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

$serverReady = Test-PandafaceLocalServer
Write-Host ""
if ($serverReady) {
    Write-Host "[OK] Servidor local PANDAFACE activo en $studioUrl" -ForegroundColor Green
    Start-Process "$studioUrl/?source=usb"
} else {
    Write-Host "[AVISO] Inicia PANDAFACE.bat o PANDAFACE.exe en el PC para activar $studioUrl" -ForegroundColor Yellow
}

$lastSummary = ""
$lastNotifyTime = [DateTime]::MinValue

while ($true) {
    $detected = $null

    # 1. ADB por serial especifico (-s)
    $adbSerials = Get-AdbDeviceSerials $adbExe
    foreach ($serial in $adbSerials) {
        try {
            & $adbExe -s $serial forward "tcp:$videoPort" "tcp:$videoPort" 2>$null | Out-Null
            & $adbExe -s $serial forward "tcp:$ctrlPort" "tcp:$ctrlPort" 2>$null | Out-Null
            $st = Probe-CamLink "127.0.0.1" $ctrlPort
            if ($st) {
                $detected = @{
                    ip = "127.0.0.1"
                    port = if ($st.port) { [int]$st.port } else { $videoPort }
                    ctrlPort = $ctrlPort
                    live = [bool]$st.live
                    proto = if ($st.proto) { [string]$st.proto } else { "H264_TCP" }
                    via = "adb"
                    device = if ($st.device) { [string]$st.device } else { "ADB $serial" }
                    status = $st
                }
                if ($detected.live) { break }
            }
        } catch {}
    }

    # 2. Interfaces USB RNDIS/NCM (Gateway + DHCPServer + Vecinos ARP + Subred)
    $gateways = Get-CandidatePhoneIps
    if (-not $detected -or -not $detected.live) {
        foreach ($gw in $gateways) {
            $st = Probe-CamLink $gw $ctrlPort
            if ($st) {
                $candidate = @{
                    ip = $gw
                    port = if ($st.port) { [int]$st.port } else { $videoPort }
                    ctrlPort = $ctrlPort
                    live = [bool]$st.live
                    proto = if ($st.proto) { [string]$st.proto } else { "H264_TCP" }
                    via = "usb-tethering"
                    device = if ($st.device) { [string]$st.device } else { $gw }
                    status = $st
                }
                if ($candidate.live -or -not $detected) {
                    $detected = $candidate
                }
                if ($detected.live) { break }
            }
        }
    }

    # 3. Rafaga UDP CAMLINK_WHO ligada a cada interfaz IPv4 local
    if (-not $detected -or -not $detected.live) {
        $udpHit = Probe-UdpCamLink $udpPort
        if ($udpHit) {
            $msg = $udpHit.message
            $kv = @{}
            foreach ($part in $msg.Split("|")) {
                if ($part -match "=") {
                    $pair = $part.Split("=", 2)
                    $kv[$pair[0]] = $pair[1]
                }
            }
            $replyIp = if ($kv["ip"] -and $kv["ip"] -ne "127.0.0.1" -and (Test-PrivateIpv4 $kv["ip"])) {
                $kv["ip"]
            } else {
                $udpHit.remoteIp
            }
            if (Test-PrivateIpv4 $replyIp) {
                $rPort = if ($kv["port"]) { [int]$kv["port"] } else { $videoPort }
                $isLive = $msg.StartsWith("CAMLINK_LIVE")
                $st = Probe-CamLink $replyIp ($rPort + 1)
                $detected = @{
                    ip = $replyIp
                    port = if ($st -and $st.port) { [int]$st.port } else { $rPort }
                    ctrlPort = $rPort + 1
                    live = if ($st) { [bool]$st.live } else { $isLive }
                    proto = if ($st -and $st.proto) { [string]$st.proto } elseif ($kv["proto"]) { $kv["proto"] } else { "H264_TCP" }
                    via = "udp"
                    device = if ($kv["device"]) { $kv["device"] } else { $replyIp }
                    status = $st
                }
            }
        }
    }

    if ($detected) {
        $now = Get-Date
        $key = "$($detected.ip):$($detected.port):$($detected.live)"
        if ($lastSummary -ne $key -or ($now - $lastNotifyTime).TotalSeconds -ge 3) {
            $lastNotifyTime = $now
            $synced = Notify-Pandaface $detected
            if ($detected.live) {
                $tag = if ($synced) { "VINCULADO CON PANDAFACE" } else { "EN VIVO (PANDAFACE offline)" }
                Write-Host "[$tag] $($detected.ip):$($detected.port) ($($detected.via) / $($detected.proto))" -ForegroundColor Green
            } else {
                Write-Host "[DETECTADO EN ESPERA] $($detected.device) ($($detected.ip)) - Pulsa 'Transmitir' en CamLink USB" -ForegroundColor Cyan
            }
            $lastSummary = $key
        }
    } else {
        $waitMsg = if ($adbSerials.Count -gt 0) {
            "[ADB LISTO: $($adbSerials -join ', ')] Abre CamLink USB y pulsa Transmitir..."
        } elseif ($gateways.Count -gt 0) {
            "[ESPERANDO CAMLINK USB] IPs candidatas: $($gateways -join ', ')"
        } else {
            "[ESPERANDO ENLACE USB] Activa Anclaje USB (Tethering) o Depuracion USB (ADB)"
        }
        if ($lastSummary -ne $waitMsg) {
            Write-Host $waitMsg -ForegroundColor DarkYellow
            $lastSummary = $waitMsg
        }
    }

    Start-Sleep -Milliseconds 800
}
