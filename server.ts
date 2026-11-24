import "dotenv/config";
import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import os from "node:os";
import dgram from "node:dgram";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { createDecartClient, verifyClientToken } from "@decartai/sdk";
import type { Request, Response } from "express";

const execFileAsync = promisify(execFile);

function resolveAppRoot(): string {
  const execDir = path.dirname(process.execPath);
  if (
    fs.existsSync(path.join(execDir, "dist", "index.html")) &&
    !execDir.toLowerCase().includes("nodejs") &&
    !execDir.startsWith("/usr")
  ) {
    return execDir;
  }
  if (typeof __dirname !== "undefined" && __dirname) {
    return __dirname;
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // Fallback for CJS / packaged runtimes
  }
  return process.cwd();
}

const APP_ROOT = resolveAppRoot();

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_REALTIME_MODELS = [
  "lucy-2.5",
  "lucy-2.1",
  "lucy-2.6",
  "lucy-latest",
] as const;

type AllowedModel = (typeof ALLOWED_REALTIME_MODELS)[number];

interface InternalSlotDef {
  id: string;
  envVar: string;
  label: string;
  apiKey: string | null;
}

function isRealSecret(val: string | undefined): val is string {
  const trimmed = val?.trim() || "";
  return (
    trimmed !== "" &&
    trimmed !== "MY_DECART_API_KEY" &&
    trimmed !== "MY_DECART_API_KEY_2" &&
    trimmed !== "MY_DECART_API_KEY_3" &&
    !trimmed.startsWith("MY_")
  );
}

function readServerEnv(): Record<string, string | undefined> {
  const candidates = Array.from(
    new Set([
      path.resolve(process.cwd(), ".env"),
      path.resolve(APP_ROOT, ".env"),
    ])
  );
  let fileEnv: Record<string, string> = {};
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      try {
        fileEnv = { ...fileEnv, ...dotenv.parse(fs.readFileSync(envPath, "utf8")) };
      } catch {
        // Ignore malformed .env read errors
      }
    }
  }
  return { ...process.env, ...fileEnv };
}

function discoverKeySlots(): InternalSlotDef[] {
  const env = readServerEnv();
  const slots: InternalSlotDef[] = [];

  for (let i = 1; i <= 10; i++) {
    const envVar = i === 1 ? "DECART_API_KEY" : `DECART_API_KEY_${i}`;
    const rawVal = env[envVar];
    const configured = isRealSecret(rawVal);

    // Always include first 3 base slots; include slots 4..10 whenever configured
    if (i <= 3 || configured) {
      slots.push({
        id: `slot_${i}`,
        envVar,
        label:
          i === 1
            ? "Cuenta 1 (Principal)"
            : i === 2
            ? "Cuenta 2 (Respaldo)"
            : `Cuenta ${i}`,
        apiKey: configured ? rawVal.trim() : null,
      });
    }
  }

  const poolRaw = env.DECART_API_KEYS || "";
  if (poolRaw.trim()) {
    const entries = poolRaw
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter((s) => isRealSecret(s));
    entries.forEach((key, idx) => {
      slots.push({
        id: `pool_${idx + 1}`,
        envVar: "DECART_API_KEYS",
        label: `Pool #${idx + 1}`,
        apiKey: key,
      });
    });
  }

  return slots;
}

function getKeySlotsStatus(): Array<{
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
}> {
  return discoverKeySlots().map((s) => ({
    id: s.id,
    label: s.label,
    envVar: s.envVar,
    configured: Boolean(s.apiKey),
  }));
}

function resolveSlotApiKey(requestedSlot: unknown): {
  slotId: string;
  label: string;
  apiKey: string | null;
} {
  const slots = discoverKeySlots();
  const matched =
    typeof requestedSlot === "string"
      ? slots.find((s) => s.id === requestedSlot)
      : undefined;

  if (matched) {
    return {
      slotId: matched.id,
      label: matched.label,
      apiKey: matched.apiKey,
    };
  }

  const firstReady = slots.find((s) => Boolean(s.apiKey));
  if (firstReady) {
    return {
      slotId: firstReady.id,
      label: firstReady.label,
      apiKey: firstReady.apiKey,
    };
  }

  return {
    slotId: "slot_1",
    label: slots[0]?.label || "Cuenta 1 (Principal)",
    apiKey: null,
  };
}
type PeerRole = "host" | "mobile";

interface PeerMeta {
  deviceLabel?: string;
  width?: number;
  height?: number;
  fps?: number;
  facingMode?: string;
}

interface RoomState {
  id: string;
  host: WebSocket | null;
  mobile: WebSocket | null;
  hostMeta: PeerMeta | null;
  mobileMeta: PeerMeta | null;
  createdAt: number;
  lastActivity: number;
}

interface SignalSocket extends WebSocket {
  isAlive?: boolean;
  roomId?: string;
  role?: PeerRole;
}

const rooms = new Map<string, RoomState>();

function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === "string" && /^[A-Z0-9]{4,12}$/.test(roomId);
}

function safeSend(ws: WebSocket | null | undefined, payload: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Ignore closed socket writes
  }
}

function broadcastRoomState(room: RoomState): void {
  const snapshot = {
    type: "room-state",
    roomId: room.id,
    hasHost: Boolean(room.host && room.host.readyState === WebSocket.OPEN),
    hasMobile: Boolean(room.mobile && room.mobile.readyState === WebSocket.OPEN),
    hostMeta: room.hostMeta,
    mobileMeta: room.mobileMeta,
  };
  safeSend(room.host, snapshot);
  safeSend(room.mobile, snapshot);
}

async function startServer(): Promise<void> {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  // Health & capability endpoint (never exposes secret key values)
  app.get("/api/health", (_req: Request, res: Response) => {
    const keySlots = getKeySlotsStatus();
    const decartConfigured = keySlots.some((s) => s.configured);

    res.json({
      ok: true,
      decartConfigured,
      keySlots,
      supportedModels: ALLOWED_REALTIME_MODELS,
      appUrl: process.env.APP_URL || null,
    });
  });

  // Room status endpoint so mobile or PC can inspect room availability before connecting
  app.get("/api/rooms/:roomId", (req: Request, res: Response) => {
    const roomId = String(req.params.roomId || "").toUpperCase().trim();
    if (!isValidRoomId(roomId)) {
      res.status(400).json({ error: "INVALID_ROOM_ID" });
      return;
    }

    const room = rooms.get(roomId);
    res.json({
      roomId,
      exists: Boolean(room),
      hasHost: Boolean(room?.host && room.host.readyState === WebSocket.OPEN),
      hasMobile: Boolean(room?.mobile && room.mobile.readyState === WebSocket.OPEN),
      createdAt: room?.createdAt ?? null,
    });
  });

  // Mint short-lived ephemeral Decart client token on the server
  app.post("/api/decart/token", async (req: Request, res: Response) => {
    const resolved = resolveSlotApiKey(req.body?.keySlot);
    if (!resolved.apiKey) {
      res.status(503).json({
        error: "ENGINE_ACCOUNT_MISSING",
        slotId: resolved.slotId,
        message: `${resolved.label} no está disponible en el servidor.`,
      });
      return;
    }

    const requestedModel =
      typeof req.body?.model === "string" ? req.body.model.trim() : undefined;

    if (
      requestedModel &&
      !ALLOWED_REALTIME_MODELS.includes(requestedModel as AllowedModel)
    ) {
      res.status(400).json({
        error: "UNSUPPORTED_MODEL",
        message: "Modelo no soportado.",
      });
      return;
    }

    const rawExpiresIn = Number(req.body?.expiresIn);
    const expiresIn =
      Number.isFinite(rawExpiresIn) && rawExpiresIn >= 60 && rawExpiresIn <= 3600
        ? Math.round(rawExpiresIn)
        : 300;

    const rawMaxDuration = Number(req.body?.maxSessionDuration);
    const maxSessionDuration =
      Number.isFinite(rawMaxDuration) &&
      rawMaxDuration >= 30 &&
      rawMaxDuration <= 7200
        ? Math.round(rawMaxDuration)
        : undefined;

    const rawBaseUrl =
      typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
    let validatedBaseUrl: string | undefined;
    if (rawBaseUrl) {
      try {
        const parsed = new URL(rawBaseUrl);
        if (
          parsed.protocol === "https:" &&
          (parsed.hostname === "decart.ai" ||
            parsed.hostname.endsWith(".decart.ai"))
        ) {
          validatedBaseUrl = parsed.origin;
        }
      } catch {
        // Ignore invalid baseUrl override
      }
    }

    try {
      const decartServerClient = createDecartClient({
        apiKey: resolved.apiKey,
        ...(validatedBaseUrl ? { baseUrl: validatedBaseUrl } : {}),
      });
      const token = await decartServerClient.tokens.create({
        expiresIn,
        allowedModels: [...ALLOWED_REALTIME_MODELS],
        ...(maxSessionDuration
          ? { constraints: { realtime: { maxSessionDuration } } }
          : {}),
        metadata: {
          source: "pandaface-studio",
          slot: resolved.slotId,
        },
      });

      res.json({
        apiKey: token.apiKey,
        expiresAt: token.expiresAt,
        slotId: resolved.slotId,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Error de sesión";
      res.status(502).json({
        error: "ENGINE_TOKEN_ERROR",
        slotId: resolved.slotId,
        message: `Error con ${resolved.label}: ${detail}`,
      });
    }
  });

  // Live API key & connectivity verification endpoint (never exposes master key)
  app.post("/api/decart/test", async (req: Request, res: Response) => {
    const resolved = resolveSlotApiKey(req.body?.keySlot);

    if (!resolved.apiKey) {
      res.status(503).json({
        ok: false,
        configured: false,
        slotId: resolved.slotId,
        error: "ENGINE_ACCOUNT_MISSING",
        message: `${resolved.label} no está configurada.`,
      });
      return;
    }

    const rawBaseUrl =
      typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
    let validatedBaseUrl: string | undefined;
    if (rawBaseUrl) {
      try {
        const parsed = new URL(rawBaseUrl);
        if (
          parsed.protocol === "https:" &&
          (parsed.hostname === "decart.ai" ||
            parsed.hostname.endsWith(".decart.ai"))
        ) {
          validatedBaseUrl = parsed.origin;
        }
      } catch {
        // Ignore invalid override
      }
    }

    const startedAt = performance.now();
    try {
      const decartServerClient = createDecartClient({
        apiKey: resolved.apiKey,
        ...(validatedBaseUrl ? { baseUrl: validatedBaseUrl } : {}),
      });
      const token = await decartServerClient.tokens.create({
        expiresIn: 60,
        allowedModels: [...ALLOWED_REALTIME_MODELS],
        metadata: { source: "pandaface-test", slot: resolved.slotId },
      });
      const latencyMs = Math.round(performance.now() - startedAt);

      let apiKeyName: string | null = null;
      let pool: string | null = null;
      let concurrentLimit: number | null = null;
      let zeroDataRetention: boolean | null = null;

      if (token.token) {
        try {
          const claims = await verifyClientToken(token.token);
          apiKeyName = claims.apiKeyName;
          pool = claims.pool;
          concurrentLimit = claims.realtimeConcurrentSessionLimit;
          zeroDataRetention = claims.zeroDataRetention;
        } catch {
          // Offline JWKS verify optional when custom baseUrl is used
        }
      }

      res.json({
        ok: true,
        configured: true,
        slotId: resolved.slotId,
        label: resolved.label,
        latencyMs,
        apiKeyName,
        pool,
        concurrentLimit,
        zeroDataRetention,
        expiresAt: token.expiresAt,
        allowedModels: ALLOWED_REALTIME_MODELS,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Error de autenticación";
      res.status(502).json({
        ok: false,
        configured: true,
        slotId: resolved.slotId,
        label: resolved.label,
        error: "ENGINE_AUTH_FAILED",
        message: `${resolved.label} falló al autenticar: ${detail}`,
      });
    }
  });

  // --- USB CamLink APK Bridge Helpers & Endpoints ---
  function parseUsbPort(raw: unknown, fallback = 7878): number {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1024 && n <= 65534) return n;
    return fallback;
  }

  function isSafeUsbHost(raw: unknown): raw is string {
    if (typeof raw !== "string") return false;
    const host = raw.trim().toLowerCase();
    if (host === "127.0.0.1" || host === "localhost") return true;
    const parts = host.split(".");
    if (parts.length !== 4) return false;
    const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
    if (nums.some((n) => n < 0 || n > 255)) return false;
    const [a, b] = nums;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  async function tryAdbForward(
    port: number
  ): Promise<{ forwarded: boolean; serials: string[] }> {
    const candidates = ["adb"];
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(
          process.env.LOCALAPPDATA,
          "Android",
          "Sdk",
          "platform-tools",
          "adb.exe"
        )
      );
    }
    for (const bin of candidates) {
      try {
        const { stdout } = await execFileAsync(bin, ["devices"], {
          timeout: 1200,
        });
        const serials: string[] = [];
        for (const rawLine of stdout.split(/\r?\n/)) {
          const match = rawLine.trim().match(/^([^\s]+)\s+device$/);
          if (match?.[1]) serials.push(match[1]);
        }
        if (serials.length === 0) {
          return { forwarded: false, serials: [] };
        }
        let anyForwarded = false;
        for (const serial of serials) {
          try {
            await execFileAsync(
              bin,
              ["-s", serial, "forward", `tcp:${port}`, `tcp:${port}`],
              { timeout: 1200 }
            );
            await execFileAsync(
              bin,
              ["-s", serial, "forward", `tcp:${port + 1}`, `tcp:${port + 1}`],
              { timeout: 1200 }
            );
            anyForwarded = true;
          } catch {
            // Try next authorized device serial
          }
        }
        return { forwarded: anyForwarded, serials };
      } catch {
        // Try next candidate or ignore when adb is not installed
      }
    }
    return { forwarded: false, serials: [] };
  }

  interface CamLinkStatusPayload {
    live: boolean;
    restarting?: boolean;
    port: number;
    proto: string;
    lens?: string;
    resolution?: string;
    width?: number;
    height?: number;
    fps?: number;
    sensorOrientation?: number;
    torch?: boolean;
    flashSupported?: boolean;
    connectedClients?: number;
    usbIps?: string[];
  }

  let cachedFfmpegCheckedAt = 0;
  let cachedFfmpegPath: string | null = null;

  async function resolveFfmpegBinary(): Promise<string | null> {
    const now = Date.now();
    if (now - cachedFfmpegCheckedAt < 15000) {
      return cachedFfmpegPath;
    }
    const candidates = ["ffmpeg"];
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) {
        candidates.push(
          path.join(
            process.env.LOCALAPPDATA,
            "Microsoft",
            "WinGet",
            "Links",
            "ffmpeg.exe"
          )
        );
      }
      candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
    } else {
      candidates.push("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg");
    }

    for (const bin of candidates) {
      try {
        await execFileAsync(bin, ["-version"], { timeout: 1200 });
        cachedFfmpegPath = bin;
        cachedFfmpegCheckedAt = now;
        return bin;
      } catch {
        // Try next candidate
      }
    }

    cachedFfmpegPath = null;
    cachedFfmpegCheckedAt = now;
    return null;
  }

  function probeCamLinkControl(
    ip: string,
    ctrlPort: number,
    timeoutMs = 450
  ): Promise<CamLinkStatusPayload | null> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: ip,
          port: ctrlPort,
          path: "/status",
          timeout: timeoutMs,
        },
        (resp) => {
          let body = "";
          resp.setEncoding("utf8");
          resp.on("data", (chunk) => {
            if (body.length < 4096) body += chunk;
          });
          resp.on("end", () => {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              if (typeof parsed.port === "number") {
                resolve({
                  live: Boolean(parsed.live),
                  restarting:
                    typeof parsed.restarting === "boolean"
                      ? parsed.restarting
                      : undefined,
                  port: parsed.port,
                  proto: String(parsed.proto || "H264_TCP"),
                  lens:
                    typeof parsed.lens === "string" ? parsed.lens : undefined,
                  resolution:
                    typeof parsed.resolution === "string"
                      ? parsed.resolution
                      : undefined,
                  width:
                    typeof parsed.width === "number" ? parsed.width : undefined,
                  height:
                    typeof parsed.height === "number"
                      ? parsed.height
                      : undefined,
                  fps: typeof parsed.fps === "number" ? parsed.fps : undefined,
                  sensorOrientation:
                    typeof parsed.sensorOrientation === "number"
                      ? parsed.sensorOrientation
                      : undefined,
                  torch:
                    typeof parsed.torch === "boolean"
                      ? parsed.torch
                      : undefined,
                  flashSupported:
                    typeof parsed.flashSupported === "boolean"
                      ? parsed.flashSupported
                      : undefined,
                  connectedClients:
                    typeof parsed.connectedClients === "number"
                      ? parsed.connectedClients
                      : undefined,
                  usbIps: Array.isArray(parsed.usbIps)
                    ? parsed.usbIps.filter(
                        (v): v is string => typeof v === "string"
                      )
                    : undefined,
                });
                return;
              }
            } catch {
              // Not CamLink JSON
            }
            resolve(null);
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.on("error", () => resolve(null));
    });
  }

  function requestCamLinkControlPath(
    ip: string,
    ctrlPort: number,
    ctrlPath: string,
    timeoutMs = 1000
  ): Promise<{
    ok: boolean;
    supported: boolean;
    httpStatus: number;
    payload: Record<string, unknown> | null;
  }> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: ip,
          port: ctrlPort,
          path: ctrlPath,
          timeout: timeoutMs,
        },
        (resp) => {
          const status = resp.statusCode || 500;
          let body = "";
          resp.setEncoding("utf8");
          resp.on("data", (chunk) => {
            if (body.length < 4096) body += chunk;
          });
          resp.on("end", () => {
            let payload: Record<string, unknown> | null = null;
            try {
              payload = JSON.parse(body) as Record<string, unknown>;
            } catch {
              // Ignore non-JSON body
            }
            resolve({
              ok: status >= 200 && status < 300,
              supported: status !== 404 && status !== 501,
              httpStatus: status,
              payload,
            });
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, supported: true, httpStatus: 504, payload: null });
      });
      req.on("error", () => {
        resolve({ ok: false, supported: true, httpStatus: 502, payload: null });
      });
    });
  }

  async function requestCamLinkMjpeg(
    ip: string,
    ctrlPort: number,
    timeoutMs = 800
  ): Promise<boolean> {
    const res = await requestCamLinkControlPath(
      ip,
      ctrlPort,
      "/use-mjpeg",
      timeoutMs
    );
    return res.ok;
  }

  function isLocalClientHostHeader(hostHeader: string | undefined): boolean {
    if (!hostHeader) return true;
    const rawHost = hostHeader.split(":")[0].trim().toLowerCase();
    if (
      rawHost === "localhost" ||
      rawHost === "127.0.0.1" ||
      rawHost === "::1" ||
      rawHost === "[::1]"
    ) {
      return true;
    }
    return isSafeUsbHost(rawHost);
  }

  async function getOsGatewayIps(): Promise<string[]> {
    const found = new Set<string>();
    const pushCandidate = (raw: string) => {
      const ip = raw.trim();
      if (
        isSafeUsbHost(ip) &&
        ip !== "127.0.0.1" &&
        ip !== "localhost" &&
        !ip.endsWith(".255") &&
        !ip.endsWith(".0")
      ) {
        found.add(ip);
      }
    };

    try {
      if (process.platform === "win32") {
        const psScript = [
          "$ips = @();",
          "$ips += (Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {$_.IPv4DefaultGateway} | ForEach-Object {$_.IPv4DefaultGateway.NextHop});",
          "$ips += (Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction SilentlyContinue | ForEach-Object { if ($_.DHCPServer) { $_.DHCPServer }; if ($_.DefaultIPGateway) { $_.DefaultIPGateway } });",
          "$ips += (Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.State -in @('Reachable','Stale','Delay','Probe','Permanent')} | ForEach-Object {$_.IPAddress});",
          "$ips -join ','",
        ].join(" ");
        const { stdout } = await execFileAsync(
          "powershell",
          ["-NoProfile", "-Command", psScript],
          { timeout: 2200 }
        );
        for (const token of stdout.split(/[\s,;\r\n]+/)) {
          pushCandidate(token);
        }
      } else if (process.platform === "linux") {
        if (fs.existsSync("/proc/net/route")) {
          const raw = fs.readFileSync("/proc/net/route", "utf8");
          for (const line of raw.split("\n").slice(1)) {
            const cols = line.trim().split(/\s+/);
            if (
              cols.length >= 3 &&
              cols[1] === "00000000" &&
              cols[2] !== "00000000"
            ) {
              const hex = cols[2];
              if (/^[0-9A-Fa-f]{8}$/.test(hex)) {
                const b = [
                  parseInt(hex.slice(6, 8), 16),
                  parseInt(hex.slice(4, 6), 16),
                  parseInt(hex.slice(2, 4), 16),
                  parseInt(hex.slice(0, 2), 16),
                ];
                pushCandidate(b.join("."));
              }
            }
          }
        }
        if (fs.existsSync("/proc/net/arp")) {
          const arpRaw = fs.readFileSync("/proc/net/arp", "utf8");
          for (const line of arpRaw.split("\n").slice(1)) {
            const cols = line.trim().split(/\s+/);
            if (
              cols.length >= 4 &&
              cols[2] !== "0x0" &&
              cols[3] !== "00:00:00:00:00:00"
            ) {
              pushCandidate(cols[0]);
            }
          }
        }
      } else if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("netstat", ["-rn", "-f", "inet"], {
          timeout: 1500,
        });
        for (const line of stdout.split("\n")) {
          const cols = line.trim().split(/\s+/);
          if (cols[0] === "default" && cols[1]) {
            pushCandidate(cols[1]);
          }
        }
      }
    } catch {
      // Ignore OS gateway/ARP lookup failure
    }
    return Array.from(found);
  }

  interface BroadcastBindingTarget {
    localIp: string | null;
    broadcastIp: string;
  }

  function collectInterfaceDirectedBroadcasts(): BroadcastBindingTarget[] {
    const targets: BroadcastBindingTarget[] = [
      { localIp: null, broadcastIp: "255.255.255.255" },
    ];
    const seen = new Set<string>(["null:255.255.255.255"]);
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const info of addrs) {
        if (info.family !== "IPv4" || info.internal || !info.netmask) continue;
        if (!isSafeUsbHost(info.address)) continue;
        const ipParts = info.address.split(".").map(Number);
        const maskParts = info.netmask.split(".").map(Number);
        if (ipParts.length !== 4 || maskParts.length !== 4) continue;
        const ipInt =
          ((ipParts[0] << 24) |
            (ipParts[1] << 16) |
            (ipParts[2] << 8) |
            ipParts[3]) >>>
          0;
        const maskInt =
          ((maskParts[0] << 24) |
            (maskParts[1] << 16) |
            (maskParts[2] << 8) |
            maskParts[3]) >>>
          0;
        const bcastInt = ((ipInt & maskInt) | (~maskInt >>> 0)) >>> 0;
        const bcastIp = [
          (bcastInt >>> 24) & 255,
          (bcastInt >>> 16) & 255,
          (bcastInt >>> 8) & 255,
          bcastInt & 255,
        ].join(".");

        for (const targetIp of [bcastIp, "255.255.255.255"]) {
          const key = `${info.address}:${targetIp}`;
          if (!seen.has(key)) {
            seen.add(key);
            targets.push({ localIp: info.address, broadcastIp: targetIp });
          }
        }
      }
    }
    return targets;
  }

  function collectUsbCandidateIps(gatewayIps: string[]): Array<{
    ip: string;
    via: "adb" | "usb-tethering";
  }> {
    const candidates = new Map<string, "adb" | "usb-tethering">();
    for (const gw of gatewayIps) {
      candidates.set(gw, "usb-tethering");
    }
    candidates.set("192.168.42.129", "usb-tethering");
    candidates.set("192.168.43.1", "usb-tethering");
    candidates.set("127.0.0.1", "adb");

    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const info of addrs) {
        if (info.family !== "IPv4" || info.internal) continue;
        if (!isSafeUsbHost(info.address)) continue;
        const octets = info.address.split(".");
        if (octets.length !== 4) continue;
        const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
        if (!candidates.has(`${prefix}.1`)) {
          candidates.set(`${prefix}.1`, "usb-tethering");
        }
        if (!candidates.has(`${prefix}.129`)) {
          candidates.set(`${prefix}.129`, "usb-tethering");
        }
      }
    }

    return Array.from(candidates.entries()).map(([ip, via]) => ({ ip, via }));
  }

  function probeUdpCamLinkBeacon(
    udpPort = 7879,
    timeoutMs = 450
  ): Promise<
    Array<{
      ip: string;
      port: number;
      live: boolean;
      proto: string;
      deviceName?: string;
      via: "udp";
    }>
  > {
    return new Promise((resolve) => {
      const foundByKey = new Map<
        string,
        {
          ip: string;
          port: number;
          live: boolean;
          proto: string;
          deviceName?: string;
          via: "udp";
        }
      >();
      const targets = collectInterfaceDirectedBroadcasts();
      const sockets: dgram.Socket[] = [];
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        for (const s of sockets) {
          try {
            s.close();
          } catch {
            // Ignore close error
          }
        }
        resolve(Array.from(foundByKey.values()));
      };

      const timer = setTimeout(finish, timeoutMs);
      const payload = Buffer.from("CAMLINK_WHO", "utf8");

      const targetsByLocal = new Map<string, string[]>();
      for (const t of targets) {
        const key = t.localIp || "";
        const list = targetsByLocal.get(key) || [];
        list.push(t.broadcastIp);
        targetsByLocal.set(key, list);
      }

      for (const [bindIp, bcastIps] of targetsByLocal.entries()) {
        const sock = dgram.createSocket("udp4");
        sockets.push(sock);

        sock.on("error", () => {
          // Ignore individual interface bind/send failure
        });

        sock.on("message", (msg, rinfo) => {
          const text = msg.toString("utf8");
          const isLiveMsg = text.startsWith("CAMLINK_LIVE");
          const isReadyMsg = text.startsWith("CAMLINK_READY");
          if (!isLiveMsg && !isReadyMsg) return;

          const kv: Record<string, string> = {};
          for (const part of text.split("|")) {
            const eq = part.indexOf("=");
            if (eq > 0) {
              kv[part.slice(0, eq)] = part.slice(eq + 1);
            }
          }
          const ip =
            kv.ip && kv.ip !== "127.0.0.1" && isSafeUsbHost(kv.ip)
              ? kv.ip
              : rinfo.address;
          if (isSafeUsbHost(ip)) {
            const port = parseUsbPort(kv.port, 7878);
            const item = {
              ip,
              port,
              live: isLiveMsg,
              proto: kv.proto || "H264_TCP",
              deviceName: kv.device ? kv.device.slice(0, 64) : undefined,
              via: "udp" as const,
            };
            const existing = foundByKey.get(`${ip}:${port}`);
            if (!existing || (!existing.live && item.live)) {
              foundByKey.set(`${ip}:${port}`, item);
            }
          }
        });

        const sendTargets = () => {
          try {
            sock.setBroadcast(true);
            for (const targetIp of bcastIps) {
              sock.send(payload, 0, payload.length, udpPort, targetIp);
            }
          } catch {
            // Ignore send failure
          }
        };

        if (bindIp) {
          sock.bind(0, bindIp, sendTargets);
        } else {
          sock.bind(0, sendTargets);
        }
      }

      if (sockets.length === 0) {
        clearTimeout(timer);
        finish();
      }
    });
  }

  interface BridgeRegisteredDevice {
    ip: string;
    port: number;
    ctrlPort: number;
    live: boolean;
    proto: string;
    via: "adb" | "usb-tethering" | "udp" | "bridge";
    deviceName?: string;
    lens?: string;
    resolution?: string;
    width?: number;
    height?: number;
    fps?: number;
    sensorOrientation?: number;
    torch?: boolean;
    flashSupported?: boolean;
    connectedClients?: number;
    usbIps?: string[];
    registeredAt: number;
  }

  const BRIDGE_DEVICE_TTL_MS = 15_000;
  const bridgeRegisteredDevices = new Map<string, BridgeRegisteredDevice>();

  function pruneExpiredBridgeDevices() {
    const cutoff = Date.now() - BRIDGE_DEVICE_TTL_MS;
    for (const [key, item] of bridgeRegisteredDevices.entries()) {
      if (item.registeredAt < cutoff) {
        bridgeRegisteredDevices.delete(key);
      }
    }
  }

  app.post("/api/usb-cam/register", (req: Request, res: Response) => {
    if (!isLocalClientHostHeader(req.headers.host)) {
      res.status(403).json({
        ok: false,
        error: "LOCAL_ONLY",
        message: "El puente USB local solo acepta registros locales.",
      });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const rawIp = typeof body.ip === "string" ? body.ip.trim() : "";
    if (!isSafeUsbHost(rawIp) || rawIp.endsWith(".255")) {
      res.status(400).json({
        ok: false,
        error: "INVALID_USB_HOST",
        message: "Dirección USB no válida.",
      });
      return;
    }

    const port = parseUsbPort(body.port, 7878);
    const ctrlPort = parseUsbPort(body.ctrlPort, port + 1);
    const rawVia = typeof body.via === "string" ? body.via.trim() : "bridge";
    const via: BridgeRegisteredDevice["via"] =
      rawVia === "adb" ||
      rawVia === "usb-tethering" ||
      rawVia === "udp" ||
      rawVia === "bridge"
        ? rawVia
        : "bridge";

    const statusObj =
      body.status && typeof body.status === "object"
        ? (body.status as Record<string, unknown>)
        : {};

    const entry: BridgeRegisteredDevice = {
      ip: rawIp,
      port,
      ctrlPort,
      live: Boolean(
        typeof body.live === "boolean" ? body.live : statusObj.live
      ),
      proto: String(body.proto || statusObj.proto || "H264_TCP").slice(0, 32),
      via,
      deviceName:
        typeof body.device === "string"
          ? body.device.slice(0, 64)
          : typeof statusObj.device === "string"
          ? statusObj.device.slice(0, 64)
          : undefined,
      lens: typeof statusObj.lens === "string" ? statusObj.lens : undefined,
      resolution:
        typeof statusObj.resolution === "string"
          ? statusObj.resolution
          : undefined,
      width:
        typeof statusObj.width === "number" ? statusObj.width : undefined,
      height:
        typeof statusObj.height === "number" ? statusObj.height : undefined,
      fps: typeof statusObj.fps === "number" ? statusObj.fps : undefined,
      sensorOrientation:
        typeof statusObj.sensorOrientation === "number"
          ? statusObj.sensorOrientation
          : undefined,
      torch:
        typeof statusObj.torch === "boolean" ? statusObj.torch : undefined,
      flashSupported:
        typeof statusObj.flashSupported === "boolean"
          ? statusObj.flashSupported
          : undefined,
      connectedClients:
        typeof statusObj.connectedClients === "number"
          ? statusObj.connectedClients
          : undefined,
      usbIps: Array.isArray(statusObj.usbIps)
        ? statusObj.usbIps.filter(
            (v): v is string => typeof v === "string" && isSafeUsbHost(v)
          )
        : undefined,
      registeredAt: Date.now(),
    };

    pruneExpiredBridgeDevices();
    bridgeRegisteredDevices.set(`${entry.ip}:${entry.port}`, entry);

    res.json({
      ok: true,
      registered: `${entry.ip}:${entry.port}`,
      live: entry.live,
    });
  });

  app.get("/api/usb-cam/discover", async (req: Request, res: Response) => {
    const port = parseUsbPort(req.query.port, 7878);
    const ctrlPort = port + 1;
    const runningInCloud = !isLocalClientHostHeader(req.headers.host);
    pruneExpiredBridgeDevices();

    const [adbResult, udpDevices, gatewayIps, ffmpegPath] = await Promise.all([
      tryAdbForward(port),
      probeUdpCamLinkBeacon(ctrlPort, 450),
      getOsGatewayIps(),
      resolveFfmpegBinary(),
    ]);

    const adbForwarded = adbResult.forwarded;
    const candidates = collectUsbCandidateIps(gatewayIps);
    const probeResults = await Promise.all(
      candidates.map(async (c) => {
        const st = await probeCamLinkControl(c.ip, ctrlPort, 450);
        if (!st) return null;
        return {
          ip: c.ip,
          port: st.port,
          ctrlPort,
          live: st.live,
          restarting: st.restarting,
          proto: st.proto,
          via: c.via,
          lens: st.lens,
          resolution: st.resolution,
          width: st.width,
          height: st.height,
          fps: st.fps,
          sensorOrientation: st.sensorOrientation,
          torch: st.torch,
          flashSupported: st.flashSupported,
          connectedClients: st.connectedClients,
          usbIps: st.usbIps,
        };
      })
    );

    const byKey = new Map<string, Record<string, unknown>>();

    for (const item of probeResults) {
      if (item) byKey.set(`${item.ip}:${item.port}`, item);
    }
    for (const u of udpDevices) {
      const k = `${u.ip}:${u.port}`;
      if (!byKey.has(k)) {
        byKey.set(k, {
          ip: u.ip,
          port: u.port,
          ctrlPort: u.port + 1,
          live: u.live,
          proto: u.proto,
          deviceName: u.deviceName,
          via: "udp",
        });
      }
    }
    for (const [k, reg] of bridgeRegisteredDevices.entries()) {
      if (!byKey.has(k)) {
        byKey.set(k, {
          ip: reg.ip,
          port: reg.port,
          ctrlPort: reg.ctrlPort,
          live: reg.live,
          proto: reg.proto,
          via: reg.via,
          deviceName: reg.deviceName,
          lens: reg.lens,
          resolution: reg.resolution,
          width: reg.width,
          height: reg.height,
          fps: reg.fps,
          sensorOrientation: reg.sensorOrientation,
          torch: reg.torch,
          flashSupported: reg.flashSupported,
          connectedClients: reg.connectedClients,
          usbIps: reg.usbIps,
        });
      }
    }

    const devices = Array.from(byKey.values()).sort(
      (a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live))
    );
    res.json({
      ok: true,
      adbForwarded,
      adbSerials: adbResult.serials,
      ffmpegAvailable: Boolean(ffmpegPath),
      runningInCloud,
      detectedGateways: gatewayIps,
      found: devices.length > 0,
      devices,
    });
  });

  app.get("/api/usb-cam/stream", async (req: Request, res: Response) => {
    const host = String(req.query.host || "127.0.0.1").trim();
    if (!isSafeUsbHost(host)) {
      res.status(400).json({
        error: "INVALID_USB_HOST",
        message:
          "Host no permitido. Usa 127.0.0.1 (ADB) o IP privada USB (192.168.x.x / 10.x.x.x).",
      });
      return;
    }

    const port = parseUsbPort(req.query.port, 7878);
    const ctrlPort = port + 1;
    const rawPipeline = String(req.query.pipeline || "auto").toLowerCase();
    const pipeline =
      rawPipeline === "ffmpeg" || rawPipeline === "mjpeg"
        ? rawPipeline
        : "auto";
    const autoMjpeg = req.query.autoMjpeg !== "0";

    if (host === "127.0.0.1" || host === "localhost") {
      await tryAdbForward(port);
    }

    let clientClosed = false;
    let activeUpstreamReq: http.ClientRequest | null = null;
    let activeFfmpeg: ChildProcess | null = null;
    req.on("close", () => {
      clientClosed = true;
      activeUpstreamReq?.destroy();
      if (activeFfmpeg && !activeFfmpeg.killed) {
        activeFfmpeg.kill("SIGKILL");
      }
    });

    const [ffmpegBin, initialStatus] = await Promise.all([
      resolveFfmpegBinary(),
      probeCamLinkControl(host, ctrlPort, 500),
    ]);

    if (clientClosed) return;

    let status = initialStatus;
    if (
      pipeline === "ffmpeg" &&
      ffmpegBin &&
      status &&
      status.proto === "MJPEG_HTTP"
    ) {
      const sw = await requestCamLinkControlPath(
        host,
        ctrlPort,
        "/protocol?value=H264_TCP",
        800
      );
      if (sw.ok) {
        await new Promise((r) => setTimeout(r, 450));
        status = await probeCamLinkControl(host, ctrlPort, 500);
      }
    }

    const currentProto = (status?.proto || "H264_TCP").toUpperCase();
    const isCompressedTcp =
      currentProto === "H264_TCP" || currentProto === "HEVC_TCP";

    const tryMjpegUpstream = async () => {
      if (clientClosed || res.headersSent) return;

      let switchedProtocol = false;
      if (autoMjpeg) {
        const latest = await probeCamLinkControl(host, ctrlPort, 450);
        if (latest && latest.proto !== "MJPEG_HTTP") {
          switchedProtocol = await requestCamLinkMjpeg(host, ctrlPort, 800);
          if (switchedProtocol) {
            await new Promise((r) => setTimeout(r, 450));
          }
        }
      }

      const maxAttempts = switchedProtocol ? 5 : 3;

      const tryConnectUpstream = (attempt: number) => {
        if (clientClosed || res.headersSent) return;

        const upstreamReq = http.get(
          {
            hostname: host,
            port,
            path: "/video",
            timeout: 4500,
          },
          (upstreamRes) => {
            if ((upstreamRes.statusCode || 500) >= 400) {
              if (!res.headersSent) {
                res.status(502).json({
                  error: "USB_CAM_HTTP_ERROR",
                  message: `CamLink USB respondió HTTP ${upstreamRes.statusCode}.`,
                });
              }
              upstreamRes.resume();
              return;
            }

            const contentType =
              upstreamRes.headers["content-type"] ||
              "multipart/x-mixed-replace; boundary=camlinkframe";

            res.socket?.setNoDelay(true);
            res.writeHead(200, {
              "Content-Type": contentType,
              "Cache-Control": "no-store, no-cache, must-revalidate",
              Pragma: "no-cache",
              "X-Pandaface-Pipeline": "mjpeg",
              Connection: "close",
            });

            upstreamRes.pipe(res);
          }
        );

        activeUpstreamReq = upstreamReq;

        upstreamReq.on("timeout", () => {
          upstreamReq.destroy();
          if (!res.headersSent && !clientClosed) {
            res.status(504).json({
              error: "USB_CAM_TIMEOUT",
              message: `No hubo respuesta desde ${host}:${port}. Verifica que CamLink USB esté transmitiendo y el cable/túnel activo.`,
            });
          }
        });

        upstreamReq.on("error", (err: NodeJS.ErrnoException) => {
          const retryable =
            err.code === "ECONNREFUSED" || err.code === "ECONNRESET";
          if (
            retryable &&
            attempt < maxAttempts &&
            !clientClosed &&
            !res.headersSent
          ) {
            setTimeout(() => tryConnectUpstream(attempt + 1), 280);
            return;
          }
          if (!res.headersSent && !clientClosed) {
            res.status(502).json({
              error: "USB_CAM_UNREACHABLE",
              message: `No se pudo conectar a ${host}:${port} (${err.message}).`,
            });
          }
        });
      };

      tryConnectUpstream(1);
    };

    const canUseFfmpeg =
      Boolean(ffmpegBin) &&
      (pipeline === "ffmpeg" || pipeline === "auto") &&
      isCompressedTcp;

    if (canUseFfmpeg && ffmpegBin) {
      const codecFormat = currentProto === "HEVC_TCP" ? "hevc" : "h264";
      const ffArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        codecFormat,
        "-i",
        `tcp://${host}:${port}`,
        "-an",
        "-c:v",
        "mjpeg",
        "-q:v",
        "4",
        "-f",
        "mpjpeg",
        "-boundary_tag",
        "camlinkframe",
        "pipe:1",
      ];

      const child = spawn(ffmpegBin, ffArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeFfmpeg = child;

      let sentAnyFrame = false;
      let stderrTail = "";

      const startupTimer = setTimeout(() => {
        if (!sentAnyFrame && !clientClosed && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 3200);

      child.stdout.on("data", (chunk: Buffer) => {
        if (clientClosed) return;
        if (!res.headersSent) {
          clearTimeout(startupTimer);
          sentAnyFrame = true;
          res.socket?.setNoDelay(true);
          res.writeHead(200, {
            "Content-Type": "multipart/x-mixed-replace; boundary=camlinkframe",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
            "X-Pandaface-Pipeline": `ffmpeg-${codecFormat}`,
            Connection: "close",
          });
        }
        res.write(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrTail.length < 512) {
          stderrTail += chunk.toString("utf8");
        }
      });

      child.on("close", (code) => {
        clearTimeout(startupTimer);
        if (clientClosed) return;
        if (res.headersSent) {
          res.end();
          return;
        }
        if (pipeline === "auto") {
          void tryMjpegUpstream();
          return;
        }
        res.status(502).json({
          error: "FFMPEG_STREAM_FAILED",
          message: `FFmpeg (${codecFormat}) terminó antes de recibir video (código ${code ?? "?"}): ${stderrTail.trim() || "sin detalles"}`,
        });
      });

      child.on("error", () => {
        clearTimeout(startupTimer);
        if (!clientClosed && !res.headersSent && pipeline === "auto") {
          void tryMjpegUpstream();
        }
      });

      return;
    }

    await tryMjpegUpstream();
  });

  app.post("/api/usb-cam/remote", async (req: Request, res: Response) => {
    const host = String(req.body?.host || "127.0.0.1").trim();
    if (!isSafeUsbHost(host)) {
      res.status(400).json({
        ok: false,
        error: "INVALID_USB_HOST",
        message: "Host USB inválido.",
      });
      return;
    }

    const port = parseUsbPort(req.body?.port, 7878);
    const ctrlPort = port + 1;
    const action = String(req.body?.action || "").trim().toLowerCase();
    const rawValue =
      typeof req.body?.value === "string" || typeof req.body?.value === "number"
        ? String(req.body.value).trim()
        : "";

    let ctrlPath: string | null = null;
    switch (action) {
      case "status":
        ctrlPath = "/status";
        break;
      case "flip":
        if (rawValue === "BACK" || rawValue === "FRONT") {
          ctrlPath = `/flip?lens=${rawValue}`;
        } else {
          ctrlPath = "/flip";
        }
        break;
      case "torch":
        if (rawValue === "on" || rawValue === "off" || rawValue === "toggle") {
          ctrlPath = `/torch?state=${rawValue}`;
        } else {
          ctrlPath = "/torch?state=toggle";
        }
        break;
      case "resolution":
        if (
          rawValue === "FHD_1080P" ||
          rawValue === "HD_720P" ||
          rawValue === "SD_480P" ||
          rawValue === "LOW_360P"
        ) {
          ctrlPath = `/resolution?value=${rawValue}`;
        }
        break;
      case "fps":
        if (rawValue === "60" || rawValue === "30" || rawValue === "24") {
          ctrlPath = `/fps?value=${rawValue}`;
        }
        break;
      case "protocol":
        if (
          rawValue === "H264_TCP" ||
          rawValue === "HEVC_TCP" ||
          rawValue === "MJPEG_HTTP"
        ) {
          ctrlPath =
            rawValue === "MJPEG_HTTP"
              ? "/use-mjpeg"
              : `/protocol?value=${rawValue}`;
        }
        break;
      case "keyframe":
        ctrlPath = "/keyframe";
        break;
      default:
        ctrlPath = null;
    }

    if (!ctrlPath) {
      res.status(400).json({
        ok: false,
        error: "INVALID_REMOTE_ACTION",
        message: "Acción o parámetro de control remoto no permitido.",
      });
      return;
    }

    if (host === "127.0.0.1" || host === "localhost") {
      await tryAdbForward(port);
    }

    const result = await requestCamLinkControlPath(
      host,
      ctrlPort,
      ctrlPath,
      1200
    );

    if (!result.ok) {
      res.status(result.supported ? 502 : 501).json({
        ok: false,
        supported: result.supported,
        httpStatus: result.httpStatus,
        message: !result.supported
          ? `Función no implementada en la app móvil (${ctrlPath.split("?")[0]}).`
          : `No se pudo ejecutar ${ctrlPath} en ${host}:${ctrlPort}.`,
      });
      return;
    }

    const updatedStatus = await probeCamLinkControl(host, ctrlPort, 600);
    res.json({
      ok: true,
      supported: true,
      action,
      value: rawValue || null,
      response: result.payload,
      status: updatedStatus,
    });
  });

  app.get("/api/usb-cam/connect-bat", (req: Request, res: Response) => {
    const scriptCandidates = [
      path.resolve(APP_ROOT, "public", "scripts", "connect.bat"),
      path.resolve(APP_ROOT, "dist", "scripts", "connect.bat"),
      path.resolve(APP_ROOT, "connect.bat"),
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      res.status(404).json({
        ok: false,
        error: "CONNECT_BAT_MISSING",
        message: "No se encontró public/scripts/connect.bat en el servidor.",
      });
      return;
    }
    const content = fs.readFileSync(scriptPath, "utf8");
    if (req.query.format === "json") {
      res.json({
        ok: true,
        filename: "connect.bat",
        path: "public/scripts/connect.bat",
        content,
      });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="connect.bat"'
    );
    res.send(content);
  });

  app.get("/api/usb-cam/adb-bat", (req: Request, res: Response) => {
    const port = parseUsbPort(req.query.port, 7878);
    const ctrlPort = port + 1;
    const bat = [
      "@echo off",
      "title PANDAFACE + CamLink USB Bridge",
      `echo Tunel ADB USB hacia puerto ${port} y control ${ctrlPort}...`,
      ":loop",
      `adb forward tcp:${port} tcp:${port} >nul 2>&1`,
      `adb forward tcp:${ctrlPort} tcp:${ctrlPort} >nul 2>&1`,
      "timeout /t 2 /nobreak >nul",
      "goto loop",
      "",
    ].join("\r\n");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="PANDAFACE-ADB-USB.bat"'
    );
    res.send(bat);
  });

  const server = http.createServer(app);

  // WebSocket signaling server on /ws/signal (same HTTP server, port 3000)
  const wss = new WebSocketServer({
    server,
    path: "/ws/signal",
  });

  wss.on("connection", (ws: SignalSocket) => {
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        safeSend(ws, { type: "error", message: "Invalid JSON payload" });
        return;
      }

      const type = msg.type;
      if (typeof type !== "string") return;

      if (type === "join") {
        const roomId = String(msg.roomId || "").toUpperCase().trim();
        const role = msg.role === "host" || msg.role === "mobile" ? msg.role : null;

        if (!isValidRoomId(roomId) || !role) {
          safeSend(ws, {
            type: "error",
            code: "INVALID_JOIN",
            message: "Código de sala o rol inválido.",
          });
          return;
        }

        // Leave previous room if rejoining
        if (ws.roomId && ws.role) {
          const prev = rooms.get(ws.roomId);
          if (prev && prev[ws.role] === ws) {
            prev[ws.role] = null;
            broadcastRoomState(prev);
          }
        }

        let room = rooms.get(roomId);
        if (!room) {
          room = {
            id: roomId,
            host: null,
            mobile: null,
            hostMeta: null,
            mobileMeta: null,
            createdAt: Date.now(),
            lastActivity: Date.now(),
          };
          rooms.set(roomId, room);
        }

        // Replace existing socket for the same role gracefully
        const existingPeer = room[role];
        if (existingPeer && existingPeer !== ws && existingPeer.readyState === WebSocket.OPEN) {
          safeSend(existingPeer, {
            type: "replaced",
            message: "Otro dispositivo ocupó este rol en la sala.",
          });
          existingPeer.close(4001, "Replaced by newer connection");
        }

        ws.roomId = roomId;
        ws.role = role;
        room[role] = ws;
        room.lastActivity = Date.now();

        const meta: PeerMeta =
          typeof msg.meta === "object" && msg.meta !== null
            ? (msg.meta as PeerMeta)
            : {};

        if (role === "host") {
          room.hostMeta = meta;
        } else {
          room.mobileMeta = meta;
        }

        safeSend(ws, {
          type: "joined",
          roomId,
          role,
          hasHost: Boolean(room.host && room.host.readyState === WebSocket.OPEN),
          hasMobile: Boolean(room.mobile && room.mobile.readyState === WebSocket.OPEN),
        });

        // Notify opposite peer
        const peerRole: PeerRole = role === "host" ? "mobile" : "host";
        safeSend(room[peerRole], {
          type: "peer-joined",
          role,
          meta,
        });

        broadcastRoomState(room);
        return;
      }

      if (!ws.roomId || !ws.role) return;
      const room = rooms.get(ws.roomId);
      if (!room) return;
      room.lastActivity = Date.now();

      const targetRole: PeerRole = ws.role === "host" ? "mobile" : "host";
      const targetSocket = room[targetRole];

      if (type === "offer" || type === "answer" || type === "ice-candidate") {
        safeSend(targetSocket, {
          type,
          from: ws.role,
          sdp: msg.sdp,
          candidate: msg.candidate,
        });
        return;
      }

      if (type === "mobile-meta" && ws.role === "mobile") {
        const meta: PeerMeta =
          typeof msg.meta === "object" && msg.meta !== null
            ? (msg.meta as PeerMeta)
            : {};
        room.mobileMeta = { ...room.mobileMeta, ...meta };
        safeSend(room.host, {
          type: "mobile-meta",
          meta: room.mobileMeta,
        });
        return;
      }

      if (type === "host-command" && ws.role === "host") {
        safeSend(room.mobile, {
          type: "host-command",
          command: msg.command,
          value: msg.value,
        });
        return;
      }

      if (type === "ping-rtt") {
        safeSend(ws, {
          type: "pong-rtt",
          sentAt: msg.sentAt,
        });
      }
    });

    ws.on("close", () => {
      if (!ws.roomId || !ws.role) return;
      const room = rooms.get(ws.roomId);
      if (!room) return;

      if (room[ws.role] === ws) {
        room[ws.role] = null;
        if (ws.role === "mobile") room.mobileMeta = null;
        if (ws.role === "host") room.hostMeta = null;

        const oppositeRole: PeerRole = ws.role === "host" ? "mobile" : "host";
        safeSend(room[oppositeRole], {
          type: "peer-left",
          role: ws.role,
        });
        broadcastRoomState(room);
      }

      if (!room.host && !room.mobile) {
        rooms.delete(ws.roomId);
      }
    });
  });

  // Heartbeat & stale room cleanup
  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      const sock = client as SignalSocket;
      if (sock.isAlive === false) {
        sock.terminate();
        continue;
      }
      sock.isAlive = false;
      sock.ping();
    }

    const now = Date.now();
    for (const [id, room] of rooms.entries()) {
      const hostDead = !room.host || room.host.readyState !== WebSocket.OPEN;
      const mobileDead = !room.mobile || room.mobile.readyState !== WebSocket.OPEN;
      if (hostDead && mobileDead && now - room.lastActivity > 1000 * 60 * 30) {
        rooms.delete(id);
      }
    }
  }, 20000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  // Vite dev middleware or production static assets
  const distDir = path.resolve(APP_ROOT, "dist");
  const entryName = path.basename(process.argv[1] || "").toLowerCase();
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.PANDAFACE_PORTABLE === "1" ||
    (fs.existsSync(path.join(distDir, "index.html")) &&
      (entryName.endsWith(".cjs") || entryName.endsWith(".exe")));

  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get("*", (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    }
  }

  const openBrowserOnStart =
    process.env.PANDAFACE_OPEN_BROWSER === "1" ||
    process.argv.includes("--open");

  const launchDesktopBrowser = (url: string) => {
    if (!openBrowserOnStart) return;
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  };

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && openBrowserOnStart) {
      console.log(
        `[PANDAFACE] Puerto ${PORT} ya activo, abriendo http://localhost:${PORT}`
      );
      launchDesktopBrowser(`http://localhost:${PORT}`);
      setTimeout(() => process.exit(0), 600);
      return;
    }
    console.error("Failed to start server:", err);
    process.exit(1);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[PANDAFACE] Server listening on http://localhost:${PORT}`);
    launchDesktopBrowser(`http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
