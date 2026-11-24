package com.example.stream

import com.example.data.StreamProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket

class UdpDiscoveryBeacon(
    private val onSwitchToMjpegRequested: () -> Unit = {}
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var beaconJob: Job? = null
    private var udpResponderJob: Job? = null
    private var httpControlJob: Job? = null

    private var udpListenSocket: DatagramSocket? = null
    private var httpServerSocket: ServerSocket? = null

    @Volatile
    private var isLive: Boolean = false

    @Volatile
    private var lastPort: Int = 7878

    @Volatile
    private var lastProtocol: StreamProtocol = StreamProtocol.H264_TCP

    fun start(port: Int, protocol: StreamProtocol) {
        stopServersOnly()
        isLive = true
        lastPort = port
        lastProtocol = protocol

        // 1. Outbound periodic UDP broadcast (works when firewall allows or on local LAN)
        beaconJob = scope.launch {
            runCatching {
                DatagramSocket().use { socket ->
                    socket.broadcast = true
                    while (isActive && isLive) {
                        sendBroadcastBurst(socket, buildPayload("CAMLINK_LIVE", port, protocol))
                        delay(BEACON_INTERVAL_MS)
                    }
                }
            }
        }

        // 2. UDP listener for PC-initiated CAMLINK_WHO (unicast reply pierces Windows Firewall)
        udpResponderJob = scope.launch {
            runCatching {
                val sock = DatagramSocket(null).apply {
                    reuseAddress = true
                    bind(InetSocketAddress("0.0.0.0", DISCOVERY_PORT))
                    broadcast = true
                }
                udpListenSocket = sock
                val buf = ByteArray(512)
                while (isActive && !sock.isClosed) {
                    val packet = DatagramPacket(buf, buf.size)
                    sock.receive(packet)
                    val msg = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    if (msg.startsWith("CAMLINK_WHO") && isLive) {
                        val ip = pickBestLocalIp()
                        val reply = "${buildPayload("CAMLINK_LIVE", lastPort, lastProtocol)}|ip=$ip"
                        val replyBytes = reply.toByteArray(Charsets.UTF_8)
                        val replyPacket = DatagramPacket(
                            replyBytes,
                            replyBytes.size,
                            packet.address,
                            packet.port
                        )
                        sock.send(replyPacket)
                    }
                }
            }
        }

        // 3. Lightweight HTTP Control/Status server on TCP (port + 1) for PC outbound probes
        httpControlJob = scope.launch {
            runCatching {
                val ss = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress("0.0.0.0", port + 1))
                }
                httpServerSocket = ss
                while (isActive && !ss.isClosed) {
                    val client = try {
                        ss.accept()
                    } catch (_: Exception) {
                        break
                    }
                    launch { handleControlRequest(client) }
                }
            }
        }
    }

    fun stop() {
        val wasLive = isLive
        isLive = false
        stopServersOnly()
        if (wasLive) {
            scope.launch {
                runCatching {
                    DatagramSocket().use { socket ->
                        socket.broadcast = true
                        val payload = buildPayload("CAMLINK_STOP", lastPort, lastProtocol)
                        sendBroadcastBurst(socket, payload)
                    }
                }
            }
        }
    }

    private fun stopServersOnly() {
        beaconJob?.cancel()
        beaconJob = null
        udpResponderJob?.cancel()
        udpResponderJob = null
        httpControlJob?.cancel()
        httpControlJob = null
        runCatching { udpListenSocket?.close() }
        udpListenSocket = null
        runCatching { httpServerSocket?.close() }
        httpServerSocket = null
    }

    private fun handleControlRequest(client: Socket) {
        try {
            client.soTimeout = 1500
            val reader = BufferedReader(InputStreamReader(client.getInputStream()))
            val requestLine = reader.readLine().orEmpty()
            val path = requestLine.split(" ").getOrNull(1) ?: "/status"

            if (path.startsWith("/use-mjpeg")) {
                if (lastProtocol != StreamProtocol.MJPEG_HTTP) {
                    lastProtocol = StreamProtocol.MJPEG_HTTP
                    onSwitchToMjpegRequested()
                }
            }

            val body = """{"live":$isLive,"port":$lastPort,"proto":"${lastProtocol.name}"}"""
            val bodyBytes = body.toByteArray(Charsets.UTF_8)
            val response = (
                "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/json\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Content-Length: ${bodyBytes.size}\r\n" +
                    "Connection: close\r\n\r\n"
                ).toByteArray(Charsets.US_ASCII)

            client.getOutputStream().use { out ->
                out.write(response)
                out.write(bodyBytes)
                out.flush()
            }
        } catch (_: Exception) {
            // Ignore transient probes
        } finally {
            runCatching { client.close() }
        }
    }

    private fun sendBroadcastBurst(socket: DatagramSocket, payloadBase: String) {
        val targets = collectBroadcastTargets()
        targets.forEach { (localIp, broadcastAddr) ->
            runCatching {
                val message = "$payloadBase|ip=$localIp"
                val bytes = message.toByteArray(Charsets.UTF_8)
                val packet = DatagramPacket(bytes, bytes.size, broadcastAddr, DISCOVERY_PORT)
                socket.send(packet)
            }
        }
    }

    companion object {
        const val DISCOVERY_PORT = 7879
        private const val BEACON_INTERVAL_MS = 500L

        fun buildPayload(tag: String, port: Int, protocol: StreamProtocol): String {
            return "$tag|port=$port|proto=${protocol.name}"
        }

        fun pickBestLocalIp(): String {
            var fallback = "127.0.0.1"
            runCatching {
                val interfaces = NetworkInterface.getNetworkInterfaces()
                while (interfaces != null && interfaces.hasMoreElements()) {
                    val nif = interfaces.nextElement()
                    if (!nif.isUp || nif.isLoopback) continue
                    val name = nif.name.lowercase()
                    val addrs = nif.inetAddresses
                    while (addrs.hasMoreElements()) {
                        val addr = addrs.nextElement()
                        if (addr is Inet4Address && !addr.isLoopbackAddress) {
                            val ip = addr.hostAddress ?: continue
                            if (name.startsWith("rndis") || name.startsWith("usb") || name.startsWith("ncm")) {
                                return ip
                            }
                            if (fallback == "127.0.0.1") fallback = ip
                        }
                    }
                }
            }
            return fallback
        }

        fun collectBroadcastTargets(): List<Pair<String, InetAddress>> {
            val targets = mutableListOf<Pair<String, InetAddress>>()
            var primaryIp = "127.0.0.1"

            runCatching {
                val interfaces = NetworkInterface.getNetworkInterfaces()
                while (interfaces != null && interfaces.hasMoreElements()) {
                    val nif = interfaces.nextElement()
                    if (!nif.isUp || nif.isLoopback) continue
                    for (ifAddr in nif.interfaceAddresses) {
                        val addr = ifAddr.address
                        if (addr is Inet4Address && !addr.isLoopbackAddress) {
                            val hostIp = addr.hostAddress ?: continue
                            if (nif.name.lowercase().let {
                                    it.startsWith("rndis") || it.startsWith("usb") || it.startsWith("ncm")
                                }
                            ) {
                                primaryIp = hostIp
                            } else if (primaryIp == "127.0.0.1") {
                                primaryIp = hostIp
                            }
                            ifAddr.broadcast?.let { bcast ->
                                targets.add(hostIp to bcast)
                            }
                        }
                    }
                }
            }

            runCatching {
                targets.add(primaryIp to InetAddress.getByName("255.255.255.255"))
            }
            return targets.distinctBy { "${it.first}:${it.second.hostAddress}" }
        }
    }
}
