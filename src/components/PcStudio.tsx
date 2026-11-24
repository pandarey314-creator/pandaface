import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDecartClient, models, type RealTimeClient } from "@decartai/sdk";
import { QRCodeSVG } from "qrcode.react";
import {
  AppWindow,
  Camera,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Flashlight,
  FlipHorizontal2,
  ImagePlus,
  Laptop,
  Maximize2,
  Minimize2,
  MonitorPlay,
  PictureInPicture2,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Square,
  Upload,
  Usb,
  Video,
  Volume2,
  VolumeX,
  Wifi,
} from "lucide-react";
import {
  DEFAULT_DECART_API_CONFIG,
  FACE_PRESETS,
  LUCY_MODELS,
  type AdbScannedDevice,
  type ApiUserProfile,
  type DecartApiConfig,
  type DecartCodec,
  type DecartMirrorMode,
  type DecartResolution,
  type DecartSessionPhase,
  type FacePreset,
  type KeySlotId,
  type KeySlotInfo,
  type LucyModelCategory,
  type LucyModelId,
  type MobileStreamMeta,
  type PeerConnectionPhase,
  type StudioTelemetry,
  type UsbCamDevice,
  type UsbCamPhase,
  type UsbPipelinePreference,
  type UsbRotationDeg,
  type VideoSourceMode,
  type ViewLayoutMode,
} from "../types/studio";
import {
  RTC_CONFIG,
  getSignalWsUrl,
  imageUrlToFile,
  prioritizeLowLatencyCodecs,
} from "../lib/webrtcConfig";
import {
  startMjpegCanvasStream,
  type MjpegStreamHandle,
} from "../lib/mjpegStreamClient";

const API_CONFIG_STORAGE_KEY = "lucycast_api_config_v1";
const KEY_SLOT_STORAGE_KEY = "lucycast_key_slot_v1";

function loadSavedApiConfig(): DecartApiConfig {
  try {
    const raw = localStorage.getItem(API_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_DECART_API_CONFIG;
    const parsed = JSON.parse(raw) as Partial<DecartApiConfig>;
    return { ...DEFAULT_DECART_API_CONFIG, ...parsed };
  } catch {
    return DEFAULT_DECART_API_CONFIG;
  }
}

function loadSavedKeySlot(): KeySlotId {
  try {
    const saved = localStorage.getItem(KEY_SLOT_STORAGE_KEY);
    if (saved && /^(slot_\d+|pool_\d+)$/.test(saved)) {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return "slot_1";
}

interface PcStudioProps {
  roomId: string;
  onRegenerateRoom: () => void;
  decartConfigured: boolean | null;
  keySlots: KeySlotInfo[];
  onRefreshHealth: () => void;
  broadcastMode: boolean;
  onBroadcastModeChange: (active: boolean) => void;
  activeApiUser: ApiUserProfile | null;
  appliedRevision: number;
  onOpenAdmin: () => void;
}

const PROMPT_TEMPLATES: Array<{ label: string; text: string }> = [
  {
    label: "Cambio de rostro fiel",
    text: "Replace the person's face and hairstyle with the exact identity from the reference image, matching original lighting, natural skin texture, facial expressions, and background seamlessly.",
  },
  {
    label: "Solo rostro (conservar cabello)",
    text: "Swap only the facial features from the reference image onto the speaker while keeping the speaker's current hairstyle, clothing, lighting, and room background intact.",
  },
  {
    label: "Estilo cinematográfico (Restyle)",
    text: "Transform the entire video scene into a moody cinematic neo-noir aesthetic with crisp studio rim lighting and natural film grain while preserving exact motion.",
  },
  {
    label: "Prueba de vestuario (Try-On)",
    text: "Apply the garment from the reference image naturally onto the speaker with accurate fabric folds, realistic lighting, and seamless torso movement.",
  },
];

interface WebUsbDeviceSummary {
  id: string;
  productName: string;
  manufacturerName: string;
  vendorId: number;
  productId: number;
  serialNumber: string | null;
}

interface WebUsbApiDevice {
  productName?: string;
  manufacturerName?: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

interface WebUsbConnectionEvent extends Event {
  device?: WebUsbApiDevice;
}

interface NavigatorWithUsb extends Navigator {
  usb?: {
    getDevices: () => Promise<WebUsbApiDevice[]>;
    requestDevice: (options: {
      filters: Array<{ vendorId?: number }>;
    }) => Promise<WebUsbApiDevice>;
    addEventListener?: (
      type: "connect" | "disconnect",
      listener: (event: WebUsbConnectionEvent) => void
    ) => void;
    removeEventListener?: (
      type: "connect" | "disconnect",
      listener: (event: WebUsbConnectionEvent) => void
    ) => void;
  };
}

const ANDROID_USB_VENDOR_FILTERS: Array<{ vendorId: number }> = [
  { vendorId: 0x18d1 }, // Google / Android ADB & RNDIS
  { vendorId: 0x04e8 }, // Samsung
  { vendorId: 0x2717 }, // Xiaomi
  { vendorId: 0x2a70 }, // OnePlus
  { vendorId: 0x12d1 }, // Huawei
  { vendorId: 0x22b8 }, // Motorola
  { vendorId: 0x22d9 }, // OPPO / Realme
  { vendorId: 0x2d95 }, // Vivo
  { vendorId: 0x1004 }, // LG
  { vendorId: 0x0fce }, // Sony
  { vendorId: 0x0b05 }, // ASUS
];

interface UsbDeviceDetectorProps {
  usbDevices: UsbCamDevice[];
  usbLiveDevice: UsbCamDevice | null;
  usbPhase: UsbCamPhase;
  usbFfmpegAvailable: boolean | null;
  adbDevices: AdbScannedDevice[];
  adbInstalled: boolean | null;
  onSelectDevice: (device: UsbCamDevice) => void;
  onRescanNetworkUsb: () => void;
}

export type UsbHardwareConnectionState = "conectado" | "desconectado";

export const UsbDeviceDetector: React.FC<UsbDeviceDetectorProps> = ({
  usbDevices,
  usbLiveDevice,
  usbPhase,
  usbFfmpegAvailable,
  adbDevices,
  adbInstalled,
  onSelectDevice,
  onRescanNetworkUsb,
}) => {
  const [webUsbSupported, setWebUsbSupported] = useState<boolean>(false);
  const [webUsbDevices, setWebUsbDevices] = useState<WebUsbDeviceSummary[]>([]);
  const [webUsbStatus, setWebUsbStatus] =
    useState<UsbHardwareConnectionState>("desconectado");
  const [webUsbNote, setWebUsbNote] = useState<string | null>(null);
  const [copiedBat, setCopiedBat] = useState<boolean>(false);

  const mapWebUsbDevice = useCallback(
    (d: WebUsbApiDevice, idx: number): WebUsbDeviceSummary => ({
      id: `${d.vendorId}-${d.productId}-${d.serialNumber || idx}`,
      productName: d.productName || "Dispositivo Móvil Android USB",
      manufacturerName: d.manufacturerName || "USB",
      vendorId: d.vendorId,
      productId: d.productId,
      serialNumber: d.serialNumber || null,
    }),
    []
  );

  const refreshWebUsbDevices = useCallback(async () => {
    const nav = navigator as NavigatorWithUsb;
    if (!nav.usb || typeof nav.usb.getDevices !== "function") {
      setWebUsbSupported(false);
      setWebUsbDevices([]);
      setWebUsbStatus("desconectado");
      return;
    }
    setWebUsbSupported(true);
    try {
      const devices = await nav.usb.getDevices();
      const mapped = devices.map(mapWebUsbDevice);
      setWebUsbDevices(mapped);
      setWebUsbStatus(mapped.length > 0 ? "conectado" : "desconectado");
    } catch {
      setWebUsbStatus("desconectado");
      setWebUsbNote("WebUSB bloqueado en este contexto del navegador.");
    }
  }, [mapWebUsbDevice]);

  useEffect(() => {
    void refreshWebUsbDevices();
    const nav = navigator as NavigatorWithUsb;
    const usbApi = nav.usb;
    if (!usbApi?.addEventListener) return;

    const onConnect = (event: WebUsbConnectionEvent) => {
      if (event.device) {
        const added = mapWebUsbDevice(event.device, 0);
        setWebUsbDevices((prev) =>
          prev.some((item) => item.id === added.id) ? prev : [...prev, added]
        );
        setWebUsbStatus("conectado");
      }
      void refreshWebUsbDevices();
      onRescanNetworkUsb();
    };

    const onDisconnect = (event: WebUsbConnectionEvent) => {
      if (event.device) {
        const prefix = `${event.device.vendorId}-${event.device.productId}-`;
        setWebUsbDevices((prev) => {
          const next = prev.filter(
            (item) =>
              !item.id.startsWith(prefix) ||
              (event.device?.serialNumber &&
                item.serialNumber !== event.device.serialNumber)
          );
          setWebUsbStatus(next.length > 0 ? "conectado" : "desconectado");
          return next;
        });
      }
      void refreshWebUsbDevices();
      onRescanNetworkUsb();
    };

    usbApi.addEventListener("connect", onConnect);
    usbApi.addEventListener("disconnect", onDisconnect);
    return () => {
      usbApi.removeEventListener?.("connect", onConnect);
      usbApi.removeEventListener?.("disconnect", onDisconnect);
    };
  }, [mapWebUsbDevice, onRescanNetworkUsb, refreshWebUsbDevices]);

  const handleRequestWebUsb = async () => {
    const nav = navigator as NavigatorWithUsb;
    if (!nav.usb || typeof nav.usb.requestDevice !== "function") {
      setWebUsbNote(
        "WebUSB no está disponible en este navegador; usando detección automática RNDIS/ADB."
      );
      return;
    }
    setWebUsbNote(null);
    try {
      const selected = await nav.usb.requestDevice({
        filters: ANDROID_USB_VENDOR_FILTERS,
      });
      if (selected) {
        const mapped = mapWebUsbDevice(selected, 0);
        setWebUsbDevices((prev) =>
          prev.some((item) => item.id === mapped.id) ? prev : [...prev, mapped]
        );
        setWebUsbStatus("conectado");
      }
      await refreshWebUsbDevices();
      onRescanNetworkUsb();
    } catch (err) {
      if ((err as { name?: string })?.name !== "NotFoundError") {
        setWebUsbNote(
          "No se autorizó dispositivo WebUSB; puedes usar Anclaje USB o connect.bat."
        );
      }
    }
  };

  const handleCopyBat = async () => {
    try {
      const res = await fetch("/api/usb-cam/connect-bat?format=json");
      const data = (await res.json()) as { content?: string };
      if (!data.content) return;
      await navigator.clipboard.writeText(data.content);
      setCopiedBat(true);
      window.setTimeout(() => setCopiedBat(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const activeAdbCount = adbDevices.filter(
    (d) => d.state === "device" || d.state === "unauthorized"
  ).length;
  const isConnected =
    webUsbStatus === "conectado" ||
    webUsbDevices.length > 0 ||
    activeAdbCount > 0 ||
    usbDevices.length > 0 ||
    usbPhase === "live";
  const connectionState: UsbHardwareConnectionState = isConnected
    ? "conectado"
    : "desconectado";
  const totalDetected =
    webUsbDevices.length + Math.max(usbDevices.length, activeAdbCount);

  return (
    <div className="rounded-lg bg-[#090C10] border border-white/10 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-6 h-6 rounded flex items-center justify-center border shrink-0 ${
              connectionState === "conectado"
                ? "bg-emerald-950/60 border-emerald-500/40 text-emerald-400"
                : "bg-[#11161F] border-white/10 text-slate-500"
            }`}
            title={
              connectionState === "conectado"
                ? "Dispositivo USB conectado"
                : "Dispositivo USB desconectado"
            }
          >
            <Usb className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-white truncate">
                Detector USB ({totalDetected})
              </span>
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap ${
                  connectionState === "conectado"
                    ? "text-emerald-400"
                    : "text-slate-400"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    connectionState === "conectado"
                      ? "bg-emerald-400"
                      : "bg-slate-500"
                  }`}
                />
                {connectionState === "conectado" ? "Conectado" : "Desconectado"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {webUsbSupported && (
            <button
              type="button"
              onClick={() => void handleRequestWebUsb()}
              className="px-2 py-1 rounded bg-[#11161F] hover:bg-[#161D29] border border-white/15 text-[11px] font-medium text-blue-300 hover:text-white whitespace-nowrap"
            >
              Vincular WebUSB
            </button>
          )}
          <span className="font-mono tabular-nums text-[11px] text-slate-400 whitespace-nowrap">
            FFmpeg:{" "}
            <strong
              className={
                usbFfmpegAvailable ? "text-emerald-400" : "text-slate-300"
              }
            >
              {usbFfmpegAvailable === null
                ? "—"
                : usbFfmpegAvailable
                ? "OK"
                : "MJPEG"}
            </strong>
          </span>
        </div>
      </div>

      {/* navigator.usb.getDevices() hardware list */}
      {webUsbDevices.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            Hardware WebUSB (navigator.usb · Conectado)
          </div>
          {webUsbDevices.map((dev) => (
            <div
              key={dev.id}
              className="px-2.5 py-1.5 rounded bg-[#11161F] border border-emerald-500/25 flex items-center justify-between gap-2 text-[11px]"
            >
              <span className="flex items-center gap-1.5 text-slate-200 truncate">
                <Usb className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="truncate">
                  {dev.manufacturerName} · {dev.productName}
                </span>
              </span>
              <span className="font-mono tabular-nums text-slate-400 shrink-0">
                {dev.vendorId.toString(16).padStart(4, "0")}:
                {dev.productId.toString(16).padStart(4, "0")}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Background ADB devices scanner (every 5s from mount) */}
      {adbDevices.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
            <span>ADB USB (adb devices · cada 5s)</span>
            <span className="text-emerald-400">Activo</span>
          </div>
          {adbDevices.map((dev) => {
            const isAuthorized = dev.state === "device";
            const isUnauthorized = dev.state === "unauthorized";
            return (
              <div
                key={dev.serial}
                className={`px-2.5 py-1.5 rounded bg-[#11161F] border flex items-center justify-between gap-2 text-[11px] ${
                  isAuthorized
                    ? "border-emerald-500/30"
                    : isUnauthorized
                    ? "border-amber-500/40"
                    : "border-white/10"
                }`}
              >
                <span className="flex items-center gap-1.5 text-slate-200 truncate">
                  <Usb
                    className={`w-3 h-3 shrink-0 ${
                      isAuthorized
                        ? "text-emerald-400"
                        : isUnauthorized
                        ? "text-amber-300"
                        : "text-slate-400"
                    }`}
                  />
                  <span className="truncate font-mono">
                    {dev.model ? `${dev.model} (${dev.serial})` : dev.serial}
                  </span>
                </span>
                <span
                  className={`font-mono tabular-nums shrink-0 ${
                    isAuthorized
                      ? "text-emerald-300"
                      : isUnauthorized
                      ? "text-amber-300"
                      : "text-slate-400"
                  }`}
                >
                  {isAuthorized
                    ? dev.camLinkLive
                      ? "CamLink VIVO"
                      : dev.forwarded
                      ? "ADB TCP OK"
                      : "Listo"
                    : isUnauthorized
                    ? "Autoriza en móvil"
                    : dev.state}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Active CamLink USB TCP/HTTP endpoints */}
      {usbDevices.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            CamLink USB listo para transmitir
          </div>
          <div className="flex flex-wrap gap-1.5">
            {usbDevices.map((d) => {
              const isSelected =
                usbLiveDevice?.ip === d.ip && usbLiveDevice?.port === d.port;
              return (
                <button
                  key={`${d.ip}:${d.port}`}
                  type="button"
                  onClick={() => onSelectDevice(d)}
                  className={`px-2.5 py-1 rounded font-mono tabular-nums text-[11px] whitespace-nowrap border ${
                    !d.live
                      ? "bg-[#11161F] border-amber-500/40 text-amber-200 hover:text-white"
                      : isSelected
                      ? "bg-emerald-950/50 border-emerald-500/50 text-emerald-200"
                      : "bg-[#11161F] border-emerald-500/30 text-emerald-300 hover:text-white"
                  }`}
                >
                  {d.ip}:{d.port} · {d.via} ·{" "}
                  {d.live ? d.proto : "EN ESPERA"}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-slate-400">
          {webUsbDevices.length > 0 || activeAdbCount > 0
            ? "Móvil USB detectado por hardware; abre CamLink USB y pulsa Transmitir para enlazar video."
            : adbInstalled === false
            ? "Ningún móvil USB detectado aún (sin ADB instalado en PATH; usando WebUSB y red RNDIS/UDP)."
            : "Ningún móvil USB detectado aún (escaneando adb devices cada 5s, WebUSB y red RNDIS)."}
        </div>
      )}

      {webUsbNote && (
        <div className="text-[11px] text-amber-200">{webUsbNote}</div>
      )}

      {/* Compact connect.bat launcher bar */}
      <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-300 min-w-0">
          <FileCode2 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="truncate">Puente USB PC (connect.bat)</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleCopyBat()}
            className="px-2 py-1 rounded bg-[#11161F] border border-white/10 text-[11px] text-slate-200 hover:text-white flex items-center gap-1 whitespace-nowrap"
          >
            {copiedBat ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span>Copiado</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copiar</span>
              </>
            )}
          </button>
          <a
            href="/api/usb-cam/connect-bat"
            download="connect.bat"
            className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-[11px] font-medium text-white flex items-center gap-1 whitespace-nowrap"
          >
            <Download className="w-3 h-3" />
            <span>Descargar</span>
          </a>
        </div>
      </div>
    </div>
  );
};

export const PcStudio: React.FC<PcStudioProps> = ({
  roomId,
  onRegenerateRoom,
  decartConfigured,
  keySlots,
  onRefreshHealth,
  broadcastMode,
  onBroadcastModeChange,
  activeApiUser,
  appliedRevision,
  onOpenAdmin,
}) => {
  // Source & Layout State
  const [sourceMode, setSourceMode] = useState<VideoSourceMode>("mobile");
  const [layoutMode, setLayoutMode] = useState<ViewLayoutMode>("split");
  const [mirrorInput, setMirrorInput] = useState<boolean>(false);
  const [mirrorOutputView, setMirrorOutputView] = useState<boolean>(false);
  const [outputFitMode, setOutputFitMode] = useState<"contain" | "cover">(
    "contain"
  );
  const [normalize16x9, setNormalize16x9] = useState<boolean>(true);
  const [fitMode, setFitMode] = useState<"cover" | "contain">("cover");
  const [audioMuted, setAudioMuted] = useState<boolean>(true);

  // Fullscreen & Broadcast Window Capture State
  const [isOsFullscreen, setIsOsFullscreen] = useState<boolean>(false);
  const [hudVisible, setHudVisible] = useState<boolean>(true);

  // P2P Phone Connection State
  const [peerPhase, setPeerPhase] = useState<PeerConnectionPhase>("waiting");
  const [mobileOnline, setMobileOnline] = useState<boolean>(false);
  const [mobileMeta, setMobileMeta] = useState<MobileStreamMeta | null>(null);
  const [hasInputStream, setHasInputStream] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // PC Window / Display Capture State (getDisplayMedia)
  const [windowCapturePhase, setWindowCapturePhase] = useState<
    "idle" | "selecting" | "live" | "error"
  >("idle");
  const [windowCaptureLabel, setWindowCaptureLabel] = useState<string | null>(
    null
  );
  const [windowCaptureResolution, setWindowCaptureResolution] = useState<
    string | null
  >(null);
  const [windowCaptureNote, setWindowCaptureNote] = useState<string | null>(
    null
  );

  // USB CamLink APK Connection State
  const [usbHost, setUsbHost] = useState<string>("127.0.0.1");
  const [usbPort, setUsbPort] = useState<number>(7878);
  const [usbPhase, setUsbPhase] = useState<UsbCamPhase>("idle");
  const [usbPipelinePref, setUsbPipelinePref] =
    useState<UsbPipelinePreference>("auto");
  const [usbRotationDeg, setUsbRotationDeg] = useState<UsbRotationDeg>(0);
  const [usbFfmpegAvailable, setUsbFfmpegAvailable] = useState<boolean | null>(
    null
  );
  const [usbDevices, setUsbDevices] = useState<UsbCamDevice[]>([]);
  const [adbDevices, setAdbDevices] = useState<AdbScannedDevice[]>([]);
  const [adbInstalled, setAdbInstalled] = useState<boolean | null>(null);
  const [usbLiveDevice, setUsbLiveDevice] = useState<UsbCamDevice | null>(null);
  const [usbGateways, setUsbGateways] = useState<string[]>([]);
  const [usbRunningInCloud, setUsbRunningInCloud] = useState<boolean>(false);
  const [usbStatusNote, setUsbStatusNote] = useState<string | null>(null);
  const [usbRemoteBusy, setUsbRemoteBusy] = useState<boolean>(false);
  const [usbRemoteMsg, setUsbRemoteMsg] = useState<string | null>(null);
  const [usbFps, setUsbFps] = useState<number | null>(null);
  const [usbKbps, setUsbKbps] = useState<number | null>(null);
  const [usbResolution, setUsbResolution] = useState<string | null>(null);

  // PANDAFACE Realtime State & Adjustable API Config
  const [selectedKeySlot, setSelectedKeySlot] = useState<KeySlotId>(
    loadSavedKeySlot
  );
  const [exhaustedSlots, setExhaustedSlots] = useState<Record<string, boolean>>(
    {}
  );
  const [modelCategoryFilter, setModelCategoryFilter] = useState<
    "all" | LucyModelCategory
  >("all");
  const [selectedModel, setSelectedModel] = useState<LucyModelId>("lucy-2.6");
  const [fastMode, setFastMode] = useState<boolean>(true);
  const [enhancePrompt, setEnhancePrompt] = useState<boolean>(true);
  const [showApiSettings, setShowApiSettings] = useState<boolean>(false);
  const [apiConfig, setApiConfig] = useState<DecartApiConfig>(loadSavedApiConfig);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    FACE_PRESETS[0].id
  );
  const [customImageFile, setCustomImageFile] = useState<File | null>(null);
  const [customImagePreview, setCustomImagePreview] = useState<string | null>(
    null
  );
  const [promptText, setPromptText] = useState<string>(
    FACE_PRESETS[0].recommendedPrompt
  );
  const [decartPhase, setDecartPhase] = useState<DecartSessionPhase>("idle");
  const [decartStatusNote, setDecartStatusNote] = useState<string | null>(null);
  const [decartError, setDecartError] = useState<string | null>(null);
  const [preflightResult, setPreflightResult] = useState<string | null>(null);
  const [apiTestStatus, setApiTestStatus] = useState<{
    state: "idle" | "testing" | "ok" | "error";
    message: string;
  }>({ state: "idle", message: "" });
  const [isApplyingLive, setIsApplyingLive] = useState<boolean>(false);
  const [hasOutputStream, setHasOutputStream] = useState<boolean>(false);
  const [pipWindowOpen, setPipWindowOpen] = useState<boolean>(false);
  const [outputViewersCount, setOutputViewersCount] = useState<number>(0);
  const [copiedOutputUrl, setCopiedOutputUrl] = useState<boolean>(false);

  // Recording State
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);

  // Real Measured Telemetry
  const [telemetry, setTelemetry] = useState<StudioTelemetry>({
    p2pRttMs: null,
    p2pFps: null,
    p2pBitrateKbps: null,
    p2pResolution: null,
    decartTtffMs: null,
    decartG2gMs: null,
    decartFps: null,
    decartQuality: null,
    decartLimitingFactor: null,
  });

  // Refs
  const rawVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputStageRef = useRef<HTMLDivElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const externalOutputAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const outputViewerPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const outputViewerIceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map()
  );
  const hudHideTimerRef = useRef<number | null>(null);
  const hiddenNormalizeVideoRef = useRef<HTMLVideoElement | null>(null);
  const normalizeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const normalizeRafRef = useRef<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const prevRecvBytesRef = useRef<{ bytes: number; ts: number } | null>(null);

  const phoneStreamRef = useRef<MediaStream | null>(null);
  const usbStreamRef = useRef<MediaStream | null>(null);
  const mjpegHandleRef = useRef<MjpegStreamHandle | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const windowStreamRef = useRef<MediaStream | null>(null);
  const activeDecartInputStreamRef = useRef<MediaStream | null>(null);
  const outputStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealTimeClient | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Persist adjustable API config & selected server key slot
  useEffect(() => {
    try {
      localStorage.setItem(API_CONFIG_STORAGE_KEY, JSON.stringify(apiConfig));
    } catch {
      // Ignore storage quota errors
    }
  }, [apiConfig]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY_SLOT_STORAGE_KEY, selectedKeySlot);
    } catch {
      // Ignore storage quota errors
    }
  }, [selectedKeySlot]);

  // Apply active API user profile whenever switched, edited, or applied from Admin API
  const lastAppliedUserRef = useRef<string>("");
  useEffect(() => {
    if (!activeApiUser) return;
    const syncKey = `${activeApiUser.id}:${activeApiUser.updatedAt}:${activeApiUser.lastAppliedAt ?? 0}:${appliedRevision}`;
    if (lastAppliedUserRef.current === syncKey) return;
    lastAppliedUserRef.current = syncKey;

    if (activeApiUser.assignedSlotId) {
      setSelectedKeySlot(activeApiUser.assignedSlotId);
    }
    const allowedSet = new Set(activeApiUser.allowedModels);
    const desiredModel = allowedSet.has(activeApiUser.apiSettings.model)
      ? activeApiUser.apiSettings.model
      : activeApiUser.allowedModels[0] || "lucy-2.5";
    setSelectedModel(desiredModel);
    setFastMode(activeApiUser.apiSettings.fastMode);
    setEnhancePrompt(activeApiUser.apiSettings.enhancePrompt);
    if (activeApiUser.apiSettings.defaultPrompt?.trim()) {
      setPromptText(activeApiUser.apiSettings.defaultPrompt);
    }
    setApiConfig({
      resolution: activeApiUser.apiSettings.resolution,
      preferredVideoCodec: activeApiUser.apiSettings.preferredVideoCodec,
      serverMirror: activeApiUser.apiSettings.serverMirror,
      passthroughOnStart: activeApiUser.apiSettings.passthroughOnStart,
      tokenTtlSeconds: activeApiUser.apiSettings.tokenTtlSeconds,
      maxSessionSeconds: activeApiUser.apiSettings.maxSessionSeconds,
      retries: activeApiUser.apiSettings.retries,
      capacityRetryBudgetMs: activeApiUser.apiSettings.capacityRetryBudgetMs,
      setImageTimeoutMs: activeApiUser.apiSettings.setImageTimeoutMs,
      customBaseUrl: activeApiUser.apiSettings.customBaseUrl || "",
      customRealtimeUrl: activeApiUser.apiSettings.customRealtimeUrl || "",
      debugQuality: Boolean(activeApiUser.apiSettings.debugQuality),
    });

    if (
      (sourceMode === "mobile" && !activeApiUser.permissions.canUseMobileP2p) ||
      (sourceMode === "usb" && !activeApiUser.permissions.canUseUsb) ||
      (sourceMode === "window" && !activeApiUser.permissions.canUseWindowCapture)
    ) {
      setSourceMode("webcam");
    }
  }, [activeApiUser, appliedRevision, sourceMode]);

  // Listen for OS fullscreen changes & ESC key to exit broadcast mode
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsOsFullscreen(Boolean(document.fullscreenElement));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && broadcastMode && !document.fullscreenElement) {
        onBroadcastModeChange(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [broadcastMode, onBroadcastModeChange]);

  // Auto-hide controls in Broadcast Window / Fullscreen mode after 2s of mouse stillness
  const wakeBroadcastHud = useCallback(() => {
    setHudVisible(true);
    if (hudHideTimerRef.current !== null) {
      window.clearTimeout(hudHideTimerRef.current);
    }
    hudHideTimerRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, 2000);
  }, []);

  useEffect(() => {
    if (broadcastMode || isOsFullscreen) {
      wakeBroadcastHud();
    } else {
      if (hudHideTimerRef.current !== null) {
        window.clearTimeout(hudHideTimerRef.current);
      }
      setHudVisible(true);
    }
    return () => {
      if (hudHideTimerRef.current !== null) {
        window.clearTimeout(hudHideTimerRef.current);
      }
    };
  }, [broadcastMode, isOsFullscreen, wakeBroadcastHud]);

  const toggleOsFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (outputStageRef.current) {
        await outputStageRef.current.requestFullscreen();
      }
    } catch {
      // Fallback to in-window clean broadcast mode if OS fullscreen is blocked
      onBroadcastModeChange(true);
    }
  }, [onBroadcastModeChange]);

  const mobileShareUrl = useMemo(() => {
    const origin = window.location.origin;
    return `${origin}/?mode=mobile&room=${encodeURIComponent(roomId)}`;
  }, [roomId]);

  const outputShareUrl = useMemo(() => {
    const origin = window.location.origin;
    return `${origin}/?mode=output&room=${encodeURIComponent(roomId)}&splitcam=1`;
  }, [roomId]);

  const currentModelInfo = useMemo(
    () => LUCY_MODELS.find((m) => m.id === selectedModel) || LUCY_MODELS[0],
    [selectedModel]
  );

  // Sync output stream to studio preview, floating Document-PiP window, and external ?mode=output viewers
  const syncOutputToViewerPc = useCallback(
    async (viewerId: string, stream: MediaStream | null) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const existing = outputViewerPcsRef.current.get(viewerId);
      if (existing) {
        existing.close();
        outputViewerPcsRef.current.delete(viewerId);
      }

      if (!stream || stream.getTracks().length === 0) {
        ws.send(
          JSON.stringify({
            type: "output-status",
            viewerId,
            hasOutput: false,
          })
        );
        return;
      }

      const pc = new RTCPeerConnection(RTC_CONFIG);
      outputViewerPcsRef.current.set(viewerId, pc);
      outputViewerIceQueueRef.current.set(viewerId, []);

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "output-ice-candidate",
              viewerId,
              candidate: event.candidate.toJSON(),
            })
          );
        }
      };

      try {
        const offer = await pc.createOffer();
        const tunedSdp = prioritizeLowLatencyCodecs(offer.sdp || "");
        await pc.setLocalDescription({ type: offer.type, sdp: tunedSdp });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "output-offer",
              viewerId,
              sdp: pc.localDescription,
            })
          );
        }
      } catch {
        pc.close();
        outputViewerPcsRef.current.delete(viewerId);
      }
    },
    []
  );

  const broadcastOutputStreamChange = useCallback(
    (stream: MediaStream | null) => {
      outputStreamRef.current = stream;
      if (outputVideoRef.current) {
        outputVideoRef.current.srcObject = stream;
      }
      if (pipVideoRef.current) {
        pipVideoRef.current.srcObject = stream;
        if (stream) {
          void pipVideoRef.current.play().catch(() => undefined);
        }
      }
      for (const viewerId of outputViewerPcsRef.current.keys()) {
        void syncOutputToViewerPc(viewerId, stream);
      }
      if (!stream && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "output-status", hasOutput: false })
        );
      }
    },
    [syncOutputToViewerPc]
  );

  // Open exclusive independent OS floating Output Window (Document Picture-in-Picture or Video PiP)
  const openIndependentOutputWindow = useCallback(async () => {
    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.close();
      pipWindowRef.current = null;
      pipVideoRef.current = null;
      setPipWindowOpen(false);
      return;
    }

    const docPip = (
      window as Window & {
        documentPictureInPicture?: {
          requestWindow: (opts?: {
            width?: number;
            height?: number;
          }) => Promise<Window>;
        };
      }
    ).documentPictureInPicture;

    if (docPip?.requestWindow) {
      try {
        const pipWin = await docPip.requestWindow({
          width: 960,
          height: 540,
        });
        pipWindowRef.current = pipWin;
        setPipWindowOpen(true);

        const doc = pipWin.document;
        doc.title = "PANDAFACE · Ventana de Salida";
        doc.body.style.margin = "0";
        doc.body.style.background = "#000";
        doc.body.style.width = "100vw";
        doc.body.style.height = "100vh";
        doc.body.style.overflow = "hidden";
        doc.body.style.display = "flex";
        doc.body.style.alignItems = "center";
        doc.body.style.justifyContent = "center";
        doc.body.style.fontFamily = "system-ui, sans-serif";

        const vid = doc.createElement("video");
        vid.autoplay = true;
        vid.playsInline = true;
        vid.muted = audioMuted;
        vid.style.width = "100%";
        vid.style.height = "100%";
        vid.style.objectFit = outputFitMode;
        if (mirrorOutputView) vid.style.transform = "scaleX(-1)";
        if (outputStreamRef.current) {
          vid.srcObject = outputStreamRef.current;
          void vid.play().catch(() => undefined);
        }
        pipVideoRef.current = vid;

        const hud = doc.createElement("div");
        hud.style.cssText =
          "position:fixed;top:10px;right:10px;display:flex;gap:6px;padding:6px 8px;border-radius:10px;background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.18);opacity:0;transition:opacity 180ms ease;z-index:10;";

        const makeBtn = (label: string, onClick: () => void) => {
          const b = doc.createElement("button");
          b.textContent = label;
          b.style.cssText =
            "background:rgba(255,255,255,0.12);color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;";
          b.onclick = onClick;
          return b;
        };

        let localFit: "contain" | "cover" = outputFitMode;
        let localMirror = mirrorOutputView;
        const fitBtn = makeBtn(
          localFit === "contain" ? "Llenar" : "Ajustar",
          () => {
            localFit = localFit === "contain" ? "cover" : "contain";
            vid.style.objectFit = localFit;
            fitBtn.textContent = localFit === "contain" ? "Llenar" : "Ajustar";
          }
        );
        const mirrorBtn = makeBtn("Espejo", () => {
          localMirror = !localMirror;
          vid.style.transform = localMirror ? "scaleX(-1)" : "";
        });
        const muteBtn = makeBtn(vid.muted ? "Audio Off" : "Audio On", () => {
          vid.muted = !vid.muted;
          muteBtn.textContent = vid.muted ? "Audio Off" : "Audio On";
        });
        hud.append(fitBtn, mirrorBtn, muteBtn);

        let hideT: number | undefined;
        const showHud = () => {
          hud.style.opacity = "1";
          if (hideT) pipWin.clearTimeout(hideT);
          hideT = pipWin.setTimeout(() => {
            hud.style.opacity = "0";
          }, 1800);
        };
        doc.addEventListener("mousemove", showHud);
        doc.addEventListener("mouseenter", showHud);

        doc.body.append(vid, hud);
        pipWin.addEventListener("pagehide", () => {
          pipWindowRef.current = null;
          pipVideoRef.current = null;
          setPipWindowOpen(false);
        });
        return;
      } catch {
        // Fallback below
      }
    }

    if (
      outputVideoRef.current &&
      outputStreamRef.current &&
      typeof outputVideoRef.current.requestPictureInPicture === "function"
    ) {
      try {
        await outputVideoRef.current.requestPictureInPicture();
        setPipWindowOpen(true);
        return;
      } catch {
        // Fallback note below
      }
    }

    setDecartStatusNote(
      "Usa el enlace 'Ventana Aparte' o instala la PWA para abrir la salida independiente."
    );
  }, [audioMuted, mirrorOutputView, outputFitMode]);

  const launchSeparateOutputWindow = useCallback(async () => {
    try {
      const res = await fetch("/api/output-window/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        supported?: boolean;
      };
      if (res.ok && data.ok) {
        setDecartStatusNote(
          "Ventana independiente 'PANDAFACE Salida Camara' abierta para SplitCam y WhatsApp."
        );
        return;
      }
    } catch {
      // Fallback to target="_blank" link / PWA
    }

    if (externalOutputAnchorRef.current) {
      externalOutputAnchorRef.current.click();
      setDecartStatusNote(
        "Salida abierta aparte. Instala la PWA ('Instalar PWA') para ventana sin barra."
      );
    }
  }, [roomId]);

  const handleCopyOutputUrl = async () => {
    try {
      await navigator.clipboard.writeText(outputShareUrl);
      setCopiedOutputUrl(true);
      window.setTimeout(() => setCopiedOutputUrl(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  // Bind raw preview video element whenever layout or input changes
  const syncRawVideoElement = useCallback((stream: MediaStream | null) => {
    if (rawVideoRef.current) {
      rawVideoRef.current.srcObject = stream;
    }
    if (hiddenNormalizeVideoRef.current) {
      hiddenNormalizeVideoRef.current.srcObject = stream;
    }
    setHasInputStream(Boolean(stream && stream.getVideoTracks().length > 0));
  }, []);

  const getActiveRawStream = useCallback((): MediaStream | null => {
    if (sourceMode === "mobile") return phoneStreamRef.current;
    if (sourceMode === "usb") return usbStreamRef.current;
    if (sourceMode === "window") return windowStreamRef.current;
    return webcamStreamRef.current;
  }, [sourceMode]);

  // Stop canvas normalizer loop
  const stopNormalizer = useCallback(() => {
    if (normalizeRafRef.current !== null) {
      cancelAnimationFrame(normalizeRafRef.current);
      normalizeRafRef.current = null;
    }
  }, []);

  // Builds the MediaStream fed into Decart AI (either Direct Zero-Copy or 1280x720 Aspect-Normalized)
  const buildDecartInputStream = useCallback(
    async (rawStream: MediaStream): Promise<MediaStream> => {
      stopNormalizer();

      if (!normalize16x9) {
        return rawStream;
      }

      const sourceVideo = hiddenNormalizeVideoRef.current;
      if (!sourceVideo) return rawStream;

      sourceVideo.srcObject = rawStream;
      sourceVideo.muted = true;
      sourceVideo.playsInline = true;
      try {
        await sourceVideo.play();
      } catch {
        // Ignore autoplay promise rejections if already playing
      }

      // Wait briefly until video dimensions are ready
      if (sourceVideo.videoWidth === 0) {
        await new Promise<void>((resolve) => {
          const onMeta = () => {
            sourceVideo.removeEventListener("loadedmetadata", onMeta);
            resolve();
          };
          sourceVideo.addEventListener("loadedmetadata", onMeta);
          window.setTimeout(resolve, 400);
        });
      }

      let canvas = normalizeCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement("canvas");
        normalizeCanvasRef.current = canvas;
      }
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");

      const drawFrame = () => {
        if (ctx && sourceVideo.readyState >= 2 && sourceVideo.videoWidth > 0) {
          const vw = sourceVideo.videoWidth;
          const vh = sourceVideo.videoHeight;
          const cw = 1280;
          const ch = 720;

          ctx.fillStyle = "#090C10";
          ctx.fillRect(0, 0, cw, ch);

          const scale =
            fitMode === "cover"
              ? Math.max(cw / vw, ch / vh)
              : Math.min(cw / vw, ch / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          const dx = (cw - dw) / 2;
          const dy = (ch - dh) / 2;

          ctx.save();
          if (mirrorInput) {
            ctx.translate(cw, 0);
            ctx.scale(-1, 1);
          }
          ctx.drawImage(sourceVideo, dx, dy, dw, dh);
          ctx.restore();
        }
        normalizeRafRef.current = requestAnimationFrame(drawFrame);
      };

      normalizeRafRef.current = requestAnimationFrame(drawFrame);

      const captured = canvas.captureStream(30);
      rawStream.getAudioTracks().forEach((aTrack) => {
        captured.addTrack(aTrack);
      });
      return captured;
    },
    [fitMode, mirrorInput, normalize16x9, stopNormalizer]
  );

  // Clean up WebRTC P2P when switching room
  const teardownPeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (phoneStreamRef.current) {
      phoneStreamRef.current.getTracks().forEach((t) => t.stop());
      phoneStreamRef.current = null;
    }
    pendingCandidatesRef.current = [];
    prevRecvBytesRef.current = null;
    if (sourceMode === "mobile") {
      syncRawVideoElement(null);
    }
    setTelemetry((prev) => ({
      ...prev,
      p2pRttMs: null,
      p2pFps: null,
      p2pBitrateKbps: null,
      p2pResolution: null,
    }));
  }, [sourceMode, syncRawVideoElement]);

  // Connect PC Host to Signaling WebSocket for the current roomId
  useEffect(() => {
    const ws = new WebSocket(getSignalWsUrl());
    wsRef.current = ws;
    setPeerPhase("waiting");
    setMobileOnline(false);
    setMobileMeta(null);

    const createReceiverPc = () => {
      if (pcRef.current) {
        pcRef.current.close();
      }
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      pc.ontrack = (event) => {
        // Tune receiver jitter buffer for minimal latency
        try {
          if ("playoutDelayHint" in event.receiver) {
            (
              event.receiver as RTCRtpReceiver & { playoutDelayHint?: number }
            ).playoutDelayHint = 0;
          }
        } catch {
          // Ignore if browser disallows playoutDelayHint mutation
        }

        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        phoneStreamRef.current = remoteStream;
        if (sourceModeRef.current === "mobile") {
          syncRawVideoElement(remoteStream);
        }
        setPeerPhase("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: event.candidate.toJSON(),
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") {
          setPeerPhase("connected");
        } else if (st === "connecting") {
          setPeerPhase("signaling");
        } else if (st === "disconnected" || st === "failed") {
          setPeerPhase("waiting");
          if (sourceModeRef.current === "mobile") {
            syncRawVideoElement(null);
          }
        }
      };

      return pc;
    };

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "join",
          roomId,
          role: "host",
          meta: { deviceLabel: "PC Studio" },
        })
      );
    };

    ws.onmessage = async (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      if (data.type === "joined" || data.type === "room-state") {
        setMobileOnline(Boolean(data.hasMobile));
        if (typeof data.outputViewerCount === "number") {
          setOutputViewersCount(data.outputViewerCount);
        }
        if (data.mobileMeta) {
          setMobileMeta(data.mobileMeta as MobileStreamMeta);
        }
        if (Array.isArray(data.outputViewerIds)) {
          setOutputViewersCount(data.outputViewerIds.length);
          for (const vid of data.outputViewerIds) {
            if (typeof vid === "string") {
              void syncOutputToViewerPc(vid, outputStreamRef.current);
            }
          }
        }
        return;
      }

      if (
        data.type === "output-viewer-joined" &&
        typeof data.viewerId === "string"
      ) {
        setOutputViewersCount((c) => c + 1);
        void syncOutputToViewerPc(data.viewerId, outputStreamRef.current);
        return;
      }

      if (
        data.type === "output-viewer-left" &&
        typeof data.viewerId === "string"
      ) {
        const oldPc = outputViewerPcsRef.current.get(data.viewerId);
        if (oldPc) {
          oldPc.close();
          outputViewerPcsRef.current.delete(data.viewerId);
        }
        outputViewerIceQueueRef.current.delete(data.viewerId);
        return;
      }

      if (
        data.type === "output-answer" &&
        typeof data.viewerId === "string" &&
        data.sdp
      ) {
        const viewerPc = outputViewerPcsRef.current.get(data.viewerId);
        if (viewerPc) {
          await viewerPc.setRemoteDescription(
            new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit)
          );
          const queued =
            outputViewerIceQueueRef.current.get(data.viewerId) || [];
          for (const cand of queued) {
            await viewerPc.addIceCandidate(new RTCIceCandidate(cand));
          }
          outputViewerIceQueueRef.current.set(data.viewerId, []);
        }
        return;
      }

      if (
        data.type === "output-ice-candidate" &&
        typeof data.viewerId === "string" &&
        data.candidate
      ) {
        const viewerPc = outputViewerPcsRef.current.get(data.viewerId);
        const cand = data.candidate as RTCIceCandidateInit;
        if (viewerPc && viewerPc.remoteDescription) {
          await viewerPc.addIceCandidate(new RTCIceCandidate(cand));
        } else {
          const list = outputViewerIceQueueRef.current.get(data.viewerId) || [];
          list.push(cand);
          outputViewerIceQueueRef.current.set(data.viewerId, list);
        }
        return;
      }

      if (data.type === "peer-joined" && data.role === "mobile") {
        setMobileOnline(true);
        if (data.meta) setMobileMeta(data.meta as MobileStreamMeta);
        setPeerPhase("signaling");
        return;
      }

      if (data.type === "mobile-meta" && data.meta) {
        setMobileMeta(data.meta as MobileStreamMeta);
        return;
      }

      if (data.type === "peer-left" && data.role === "mobile") {
        setMobileOnline(false);
        setMobileMeta(null);
        setPeerPhase("waiting");
        teardownPeerConnection();
        return;
      }

      if (data.type === "offer" && data.sdp) {
        try {
          setPeerPhase("signaling");
          const pc = createReceiverPc();
          await pc.setRemoteDescription(
            new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit)
          );
          for (const cand of pendingCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
          pendingCandidatesRef.current = [];

          const answer = await pc.createAnswer();
          const tunedSdp = prioritizeLowLatencyCodecs(answer.sdp || "");
          await pc.setLocalDescription({ type: answer.type, sdp: tunedSdp });

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "answer",
                sdp: pc.localDescription,
              })
            );
          }
        } catch {
          setPeerPhase("error");
        }
        return;
      }

      if (data.type === "ice-candidate" && data.candidate) {
        const cand = data.candidate as RTCIceCandidateInit;
        const pc = pcRef.current;
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } else {
          pendingCandidatesRef.current.push(cand);
        }
      }
    };

    ws.onclose = () => {
      setMobileOnline(false);
      for (const pc of outputViewerPcsRef.current.values()) {
        pc.close();
      }
      outputViewerPcsRef.current.clear();
    };

    return () => {
      ws.close();
      wsRef.current = null;
      teardownPeerConnection();
      for (const pc of outputViewerPcsRef.current.values()) {
        pc.close();
      }
      outputViewerPcsRef.current.clear();
    };
  }, [
    roomId,
    syncOutputToViewerPc,
    syncRawVideoElement,
    teardownPeerConnection,
  ]);

  // Poll incoming P2P WebRTC stats every 1s when mobile connected
  useEffect(() => {
    if (peerPhase !== "connected") return;
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let fps: number | null = null;
        let kbps: number | null = null;
        let rttMs: number | null = null;
        let resolution: string | null = null;

        report.forEach((stat) => {
          if (stat.type === "inbound-rtp" && stat.kind === "video") {
            if (typeof stat.framesPerSecond === "number") {
              fps = Math.round(stat.framesPerSecond);
            }
            if (stat.frameWidth && stat.frameHeight) {
              resolution = `${stat.frameWidth}×${stat.frameHeight}`;
            }
            if (typeof stat.bytesReceived === "number") {
              const now = stat.timestamp || performance.now();
              if (prevRecvBytesRef.current) {
                const dtSec = (now - prevRecvBytesRef.current.ts) / 1000;
                if (dtSec > 0) {
                  kbps = Math.round(
                    ((stat.bytesReceived - prevRecvBytesRef.current.bytes) * 8) /
                      1000 /
                      dtSec
                  );
                }
              }
              prevRecvBytesRef.current = { bytes: stat.bytesReceived, ts: now };
            }
          }
          if (
            stat.type === "candidate-pair" &&
            stat.state === "succeeded" &&
            typeof stat.currentRoundTripTime === "number"
          ) {
            rttMs = Math.round(stat.currentRoundTripTime * 1000);
          }
        });

        setTelemetry((prev) => ({
          ...prev,
          p2pFps: fps,
          p2pBitrateKbps: kbps,
          p2pRttMs: rttMs,
          p2pResolution: resolution,
        }));
      } catch {
        // Ignore stats error
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [peerPhase]);

  // Sync PC-side canvas rotation live without dropping PANDAFACE WebRTC session
  useEffect(() => {
    mjpegHandleRef.current?.setTransform({ rotationDeg: usbRotationDeg });
  }, [usbRotationDeg]);

  const disconnectUsbCamera = useCallback(() => {
    if (mjpegHandleRef.current) {
      mjpegHandleRef.current.stop();
      mjpegHandleRef.current = null;
    }
    usbStreamRef.current = null;
    setUsbPhase("idle");
    setUsbFps(null);
    setUsbKbps(null);
    setUsbResolution(null);
    if (sourceMode === "usb") {
      syncRawVideoElement(null);
    }
  }, [sourceMode, syncRawVideoElement]);

  const connectUsbCamera = useCallback(
    (
      overrideHost?: string,
      overridePort?: number,
      overridePipeline?: UsbPipelinePreference
    ) => {
      const targetHost = (overrideHost ?? usbHost).trim() || "127.0.0.1";
      const targetPort = overridePort ?? usbPort;
      const targetPipeline = overridePipeline ?? usbPipelinePref;
      if (overrideHost) setUsbHost(overrideHost);
      if (overridePort) setUsbPort(overridePort);

      disconnectUsbCamera();
      setUsbPhase("connecting");
      setUsbRemoteMsg(null);
      setUsbStatusNote(
        `Conectando con CamLink USB (${targetPipeline.toUpperCase()}) en ${targetHost}:${targetPort}...`
      );
      setDecartError(null);

      const url = `/api/usb-cam/stream?host=${encodeURIComponent(
        targetHost
      )}&port=${encodeURIComponent(String(targetPort))}&pipeline=${encodeURIComponent(
        targetPipeline
      )}&autoMjpeg=1`;

      const handle = startMjpegCanvasStream({
        streamUrl: url,
        initialRotationDeg: usbRotationDeg,
        onLive: (width, height) => {
          setUsbPhase("live");
          setUsbResolution(`${width}×${height}`);
          setUsbStatusNote(
            `Recibiendo video USB (${width}×${height}) desde ${targetHost}:${targetPort}`
          );
        },
        onReconnecting: (attempt, reason) => {
          setUsbPhase("reconnecting");
          setUsbStatusNote(`${reason} (reintento ${attempt})`);
        },
        onStats: (st) => {
          setUsbFps(st.fps);
          setUsbKbps(st.kbps);
          setUsbResolution(`${st.width}×${st.height}`);
        },
        onError: (msg) => {
          setUsbPhase("error");
          setUsbStatusNote(msg);
          if (mjpegHandleRef.current === handle) {
            mjpegHandleRef.current.stop();
            mjpegHandleRef.current = null;
            usbStreamRef.current = null;
            if (sourceMode === "usb") {
              syncRawVideoElement(null);
            }
          }
        },
      });

      mjpegHandleRef.current = handle;
      usbStreamRef.current = handle.stream;
      setSourceMode("usb");
      syncRawVideoElement(handle.stream);
    },
    [
      disconnectUsbCamera,
      sourceMode,
      syncRawVideoElement,
      usbHost,
      usbPipelinePref,
      usbPort,
      usbRotationDeg,
    ]
  );

  const discoverUsbDevices = useCallback(
    async (autoConnect = true, silent = false) => {
      if (!silent) {
        setUsbPhase("discovering");
        setUsbRemoteMsg(null);
        setUsbStatusNote(
          "Buscando móvil por cable USB (Anclaje USB, ADB y UDP)..."
        );
      }
      try {
        const res = await fetch(
          `/api/usb-cam/discover?port=${encodeURIComponent(String(usbPort))}`
        );
        const data = (await res.json()) as {
          ok?: boolean;
          adbForwarded?: boolean;
          adbSerials?: string[];
          ffmpegAvailable?: boolean;
          runningInCloud?: boolean;
          detectedGateways?: string[];
          found?: boolean;
          devices?: UsbCamDevice[];
        };
        const list = Array.isArray(data.devices) ? data.devices : [];
        const liveDevices = list.filter((d) => d.live);
        const gateways = Array.isArray(data.detectedGateways)
          ? data.detectedGateways
          : [];
        const serials = Array.isArray(data.adbSerials) ? data.adbSerials : [];
        const inCloud = Boolean(data.runningInCloud);

        setUsbDevices(list);
        setUsbGateways(gateways);
        setUsbRunningInCloud(inCloud);
        if (typeof data.ffmpegAvailable === "boolean") {
          setUsbFfmpegAvailable(data.ffmpegAvailable);
        }

        if (liveDevices.length > 0) {
          const first = liveDevices[0];
          setUsbHost(first.ip);
          setUsbPort(first.port);
          setUsbLiveDevice(first);
          setUsbStatusNote(
            `Detectado CamLink USB en ${first.ip}:${first.port} (${first.via} · ${first.proto}).`
          );
          if (autoConnect) {
            connectUsbCamera(first.ip, first.port);
          } else if (!silent) {
            setUsbPhase("idle");
          }
        } else if (list.length > 0) {
          const standby = list[0];
          setUsbHost(standby.ip);
          setUsbPort(standby.port);
          setUsbLiveDevice(standby);
          if (!silent) setUsbPhase("idle");
          setUsbStatusNote(
            `Móvil detectado en espera (${standby.deviceName || standby.ip}). Pulsa 'Transmitir' en CamLink USB.`
          );
        } else {
          setUsbLiveDevice(null);
          if (!silent) setUsbPhase("idle");
          if (inCloud) {
            setUsbStatusNote(
              "Enlace remoto activo. Ejecuta PANDAFACE en localhost:3000 para acceso USB local."
            );
          } else if (data.adbForwarded || serials.length > 0) {
            setUsbStatusNote(
              `ADB listo (${serials[0] || "USB"}). Abre CamLink USB y pulsa Transmitir.`
            );
          } else if (gateways.length > 0) {
            setUsbHost(gateways[0]);
            setUsbStatusNote(`Red USB detectada (${gateways.join(", ")}).`);
          } else if (!silent) {
            setUsbStatusNote("Sin señal USB activa.");
          }
        }
      } catch {
        if (!silent) {
          setUsbPhase("error");
          setUsbStatusNote("Error al buscar dispositivos USB.");
        }
      }
    },
    [connectUsbCamera, usbPort]
  );

  // Read launch query params from connect.bat (?source=usb&usbHost=...&usbPort=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const src = params.get("source");
    const qHost = params.get("usbHost");
    const qPort = params.get("usbPort");
    if (qHost && /^(127\.0\.0\.1|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(qHost.trim())) {
      setUsbHost(qHost.trim());
    }
    if (qPort) {
      const p = Number(qPort);
      if (Number.isInteger(p) && p >= 1024 && p <= 65534) {
        setUsbPort(p);
      }
    }
    if (src === "usb") {
      setSourceMode("usb");
    }
  }, []);

  // Silent background poll while USB mode is selected & idle so connect.bat / hotplug auto-links immediately
  useEffect(() => {
    if (sourceMode !== "usb" || usbPhase !== "idle") return;
    void discoverUsbDevices(true, true);
    const timer = window.setInterval(() => {
      void discoverUsbDevices(true, true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [discoverUsbDevices, sourceMode, usbPhase]);

  // Mount-time background ADB service: runs 'adb devices' every 5s regardless of active tab
  const adbScanBusyRef = useRef<boolean>(false);
  const sourceModeRef = useRef<VideoSourceMode>(sourceMode);
  const usbPhaseRef = useRef<UsbCamPhase>(usbPhase);
  const usbPortRef = useRef<number>(usbPort);
  const connectUsbCameraRef = useRef(connectUsbCamera);

  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);
  useEffect(() => {
    usbPhaseRef.current = usbPhase;
  }, [usbPhase]);
  useEffect(() => {
    usbPortRef.current = usbPort;
  }, [usbPort]);
  useEffect(() => {
    connectUsbCameraRef.current = connectUsbCamera;
  }, [connectUsbCamera]);

  const runAdbBackgroundScan = useCallback(async () => {
    if (adbScanBusyRef.current) return;
    adbScanBusyRef.current = true;
    try {
      const targetPort = usbPortRef.current || 7878;
      const res = await fetch(
        `/api/usb-cam/adb-devices?port=${encodeURIComponent(String(targetPort))}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        ok?: boolean;
        adbInstalled?: boolean;
        adbForwarded?: boolean;
        runningInCloud?: boolean;
        devices?: AdbScannedDevice[];
        camLinkStatus?: {
          live?: boolean;
          restarting?: boolean;
          port: number;
          proto?: string;
          lens?: string;
          resolution?: string;
          width?: number;
          height?: number;
          fps?: number;
          sensorOrientation?: number;
          torch?: boolean;
          flashSupported?: boolean;
          connectedClients?: number;
        } | null;
      };

      const scannedList = Array.isArray(data.devices) ? data.devices : [];
      setAdbDevices(scannedList);
      if (typeof data.adbInstalled === "boolean") {
        setAdbInstalled(data.adbInstalled);
      }
      if (typeof data.runningInCloud === "boolean") {
        setUsbRunningInCloud(data.runningInCloud);
      }

      const authorized = scannedList.filter((d) => d.state === "device");
      const unauthorized = scannedList.filter(
        (d) => d.state === "unauthorized"
      );
      const status = data.camLinkStatus;

      setUsbDevices((prev) => {
        const nonAdb = prev.filter((item) => item.via !== "adb");
        if (authorized.length === 0) {
          return nonAdb;
        }
        if (status) {
          const adbEntry: UsbCamDevice = {
            ip: "127.0.0.1",
            port: status.port || targetPort,
            ctrlPort: (status.port || targetPort) + 1,
            live: Boolean(status.live),
            restarting: status.restarting,
            proto: status.proto || "H264_TCP",
            via: "adb",
            deviceName: authorized[0].model || authorized[0].serial,
            lens: status.lens,
            resolution: status.resolution,
            width: status.width,
            height: status.height,
            fps: status.fps,
            sensorOrientation: status.sensorOrientation,
            torch: status.torch,
            flashSupported: status.flashSupported,
            connectedClients: status.connectedClients,
          };
          return [adbEntry, ...nonAdb];
        }
        return prev;
      });

      if (usbPhaseRef.current === "idle") {
        if (authorized.length > 0 && status) {
          const camPort = status.port || targetPort;
          const adbEntry: UsbCamDevice = {
            ip: "127.0.0.1",
            port: camPort,
            ctrlPort: camPort + 1,
            live: Boolean(status.live),
            restarting: status.restarting,
            proto: status.proto || "H264_TCP",
            via: "adb",
            deviceName: authorized[0].model || authorized[0].serial,
            lens: status.lens,
            resolution: status.resolution,
            width: status.width,
            height: status.height,
            fps: status.fps,
            sensorOrientation: status.sensorOrientation,
            torch: status.torch,
            flashSupported: status.flashSupported,
            connectedClients: status.connectedClients,
          };
          setUsbHost("127.0.0.1");
          setUsbPort(camPort);
          setUsbLiveDevice(adbEntry);
          if (status.live) {
            setUsbStatusNote(
              `ADB detectó CamLink USB vivo en 127.0.0.1:${camPort} (${adbEntry.deviceName}).`
            );
            if (sourceModeRef.current === "usb") {
              connectUsbCameraRef.current("127.0.0.1", camPort);
            }
          } else {
            setUsbStatusNote(
              `Móvil ADB en espera (${adbEntry.deviceName}). Pulsa 'Transmitir' en CamLink USB.`
            );
          }
        } else if (unauthorized.length > 0) {
          setUsbStatusNote(
            `Móvil ADB detectado (${unauthorized[0].serial}). Acepta 'Depuración USB' en el móvil.`
          );
        } else if (authorized.length > 0) {
          setUsbHost("127.0.0.1");
          setUsbStatusNote(
            `ADB conectado (${authorized[0].model || authorized[0].serial}). Abre CamLink USB y pulsa Transmitir.`
          );
        }
      }
    } catch {
      // Silent retry on next 5s tick
    } finally {
      adbScanBusyRef.current = false;
    }
  }, []);

  useEffect(() => {
    void runAdbBackgroundScan();
    const adbTimer = window.setInterval(() => {
      void runAdbBackgroundScan();
    }, 5000);
    return () => window.clearInterval(adbTimer);
  }, [runAdbBackgroundScan]);

  const sendUsbRemoteCommand = useCallback(
    async (
      action:
        | "status"
        | "flip"
        | "torch"
        | "resolution"
        | "fps"
        | "protocol"
        | "keyframe",
      value?: string
    ) => {
      setUsbRemoteBusy(true);
      setUsbRemoteMsg(null);
      try {
        const res = await fetch("/api/usb-cam/remote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            host: usbHost.trim() || "127.0.0.1",
            port: usbPort,
            action,
            ...(value ? { value } : {}),
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          supported?: boolean;
          message?: string;
          status?: UsbCamDevice | null;
        };
        if (!res.ok || !data.ok) {
          setUsbRemoteMsg(
            data.message || "No se pudo aplicar el comando remoto en CamLink."
          );
          return;
        }
        if (data.status) {
          setUsbLiveDevice((prev) => ({
            ...(prev || {
              ip: usbHost.trim() || "127.0.0.1",
              port: usbPort,
              ctrlPort: usbPort + 1,
              live: true,
              proto: "MJPEG_HTTP",
              via: "manual",
            }),
            ...data.status,
          }));
        }
        setUsbRemoteMsg(
          `Comando '${action}${value ? `=${value}` : ""}' aplicado en CamLink USB.`
        );
      } catch {
        setUsbRemoteMsg("Error de red enviando control remoto a CamLink USB.");
      } finally {
        setUsbRemoteBusy(false);
      }
    },
    [usbHost, usbPort]
  );

  const stopWindowCapture = useCallback(() => {
    if (windowStreamRef.current) {
      windowStreamRef.current.getTracks().forEach((t) => t.stop());
      windowStreamRef.current = null;
    }
    setWindowCapturePhase("idle");
    setWindowCaptureLabel(null);
    setWindowCaptureResolution(null);
    if (sourceModeRef.current === "window") {
      syncRawVideoElement(null);
    }
  }, [syncRawVideoElement]);

  const startWindowCapture = useCallback(async () => {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== "function"
    ) {
      setWindowCapturePhase("error");
      const msg =
        "Tu navegador no permite capturar ventanas en este contexto (requiere HTTPS o localhost).";
      setWindowCaptureNote(msg);
      setDecartError(msg);
      return;
    }

    setWindowCapturePhase("selecting");
    setWindowCaptureNote(null);
    setDecartError(null);

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach((t) => t.stop());
        setWindowCapturePhase("error");
        setWindowCaptureNote("La ventana seleccionada no entregó pista de video.");
        return;
      }

      if (windowStreamRef.current && windowStreamRef.current !== stream) {
        windowStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      windowStreamRef.current = stream;

      const settings = videoTrack.getSettings();
      const resLabel =
        settings.width && settings.height
          ? `${settings.width}×${settings.height}`
          : null;
      setWindowCaptureLabel(videoTrack.label || "Ventana seleccionada");
      setWindowCaptureResolution(resLabel);
      setWindowCapturePhase("live");
      setWindowCaptureNote(
        resLabel
          ? `Capturando ${videoTrack.label || "ventana"} (${resLabel}).`
          : `Capturando ${videoTrack.label || "ventana"}.`
      );

      videoTrack.addEventListener("ended", () => {
        if (windowStreamRef.current === stream) {
          windowStreamRef.current = null;
          setWindowCapturePhase("idle");
          setWindowCaptureLabel(null);
          setWindowCaptureResolution(null);
          setWindowCaptureNote("Captura de ventana finalizada.");
          if (sourceModeRef.current === "window") {
            syncRawVideoElement(null);
          }
        }
      });

      if (sourceModeRef.current === "window") {
        syncRawVideoElement(stream);
      }
    } catch (err) {
      const hasExisting = Boolean(
        windowStreamRef.current &&
          windowStreamRef.current
            .getVideoTracks()
            .some((t) => t.readyState === "live")
      );
      if (hasExisting) {
        setWindowCapturePhase("live");
        return;
      }
      setWindowCapturePhase("idle");
      const errName = (err as { name?: string })?.name;
      if (errName === "NotAllowedError" || errName === "AbortError") {
        setWindowCaptureNote(
          "Selección cancelada. Pulsa 'Elegir Ventana' para escoger una aplicación o pantalla."
        );
      } else {
        const msg =
          err instanceof Error
            ? `No se pudo capturar la ventana: ${err.message}`
            : "No se pudo capturar la ventana.";
        setWindowCapturePhase("error");
        setWindowCaptureNote(msg);
        setDecartError(msg);
      }
    }
  }, [syncRawVideoElement]);

  // Handle switching between Mobile P2P, USB CamLink APK, Local PC Webcam, and Window Capture
  const handleSelectSource = async (nextSource: VideoSourceMode) => {
    if (activeApiUser) {
      if (
        (nextSource === "mobile" && !activeApiUser.permissions.canUseMobileP2p) ||
        (nextSource === "usb" && !activeApiUser.permissions.canUseUsb) ||
        (nextSource === "window" && !activeApiUser.permissions.canUseWindowCapture)
      ) {
        setDecartError(
          `El usuario "${activeApiUser.name}" no tiene permiso para usar esa fuente de video.`
        );
        return;
      }
    }
    setSourceMode(nextSource);
    setDecartError(null);

    if (nextSource === "webcam") {
      try {
        if (!webcamStreamRef.current) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
          });
          webcamStreamRef.current = stream;
        }
        syncRawVideoElement(webcamStreamRef.current);
      } catch (err) {
        setDecartError(
          err instanceof Error
            ? `No se pudo abrir la webcam del PC: ${err.message}`
            : "No se pudo abrir la webcam del PC."
        );
      }
    } else if (nextSource === "window") {
      const hasLiveWindow = Boolean(
        windowStreamRef.current &&
          windowStreamRef.current
            .getVideoTracks()
            .some((t) => t.readyState === "live")
      );
      if (hasLiveWindow && windowStreamRef.current) {
        syncRawVideoElement(windowStreamRef.current);
      } else {
        syncRawVideoElement(null);
        void startWindowCapture();
      }
    } else if (nextSource === "usb") {
      syncRawVideoElement(usbStreamRef.current);
      if (usbPhase === "idle" && !usbStreamRef.current) {
        void discoverUsbDevices(true);
      }
    } else {
      syncRawVideoElement(phoneStreamRef.current);
    }
  };

  // Resolve active reference File (uploaded or preset portrait)
  const resolveReferenceImageFile = useCallback(async (): Promise<
    File | undefined
  > => {
    if (customImageFile) return customImageFile;
    const preset = FACE_PRESETS.find((p) => p.id === selectedPresetId);
    if (!preset) return undefined;
    return imageUrlToFile(preset.imageUrl, `${preset.id}.jpg`);
  }, [customImageFile, selectedPresetId]);

  // Stop Decart AI Lucy Realtime session
  const stopDecartSession = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (realtimeClientRef.current) {
      try {
        realtimeClientRef.current.disconnect();
      } catch {
        // Ignore disconnect error
      }
      realtimeClientRef.current = null;
    }
    stopNormalizer();
    if (
      activeDecartInputStreamRef.current &&
      activeDecartInputStreamRef.current !== phoneStreamRef.current &&
      activeDecartInputStreamRef.current !== usbStreamRef.current &&
      activeDecartInputStreamRef.current !== webcamStreamRef.current &&
      activeDecartInputStreamRef.current !== windowStreamRef.current
    ) {
      activeDecartInputStreamRef.current
        .getVideoTracks()
        .forEach((t) => t.stop());
    }
    activeDecartInputStreamRef.current = null;
    broadcastOutputStreamChange(null);
    setHasOutputStream(false);
    setDecartPhase("idle");
    setDecartStatusNote(null);
    setTelemetry((prev) => ({
      ...prev,
      decartTtffMs: null,
      decartG2gMs: null,
      decartFps: null,
      decartQuality: null,
      decartLimitingFactor: null,
    }));
  }, [broadcastOutputStreamChange, stopNormalizer]);

  useEffect(() => {
    return () => {
      stopDecartSession();
      disconnectUsbCamera();
      if (pipWindowRef.current && !pipWindowRef.current.closed) {
        pipWindowRef.current.close();
      }
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (windowStreamRef.current) {
        windowStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [disconnectUsbCamera, stopDecartSession]);

  // Start PANDAFACE Realtime session
  const startDecartSession = useCallback(async () => {
    if (activeApiUser && !activeApiUser.enabled) {
      setDecartError(
        `El usuario "${activeApiUser.name}" está suspendido por el administrador.`
      );
      return;
    }

    const rawStream = getActiveRawStream();
    if (!rawStream || rawStream.getVideoTracks().length === 0) {
      setDecartError("Conecta primero una fuente de video.");
      return;
    }

    setDecartError(null);
    setDecartPhase("connecting");
    setDecartStatusNote("Conectando con PANDAFACE...");

    try {
      const inputStream = await buildDecartInputStream(rawStream);
      activeDecartInputStreamRef.current = inputStream;

      const referenceFile = await resolveReferenceImageFile();
      const modelDef = models.realtime(selectedModel);

      const serverMirrorValue: boolean | "auto" =
        apiConfig.serverMirror === "always"
          ? true
          : apiConfig.serverMirror === "auto"
          ? "auto"
          : false;

      const client = createDecartClient({
        ...(apiConfig.customBaseUrl ? { baseUrl: apiConfig.customBaseUrl } : {}),
        ...(apiConfig.customRealtimeUrl
          ? { realtimeBaseUrl: apiConfig.customRealtimeUrl }
          : {}),
        apiKeyProvider: async () => {
          const res = await fetch("/api/decart/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: activeApiUser?.id,
              keySlot: selectedKeySlot,
              model: selectedModel,
              expiresIn: apiConfig.tokenTtlSeconds,
              ...(apiConfig.maxSessionSeconds > 0
                ? { maxSessionDuration: apiConfig.maxSessionSeconds }
                : {}),
              ...(apiConfig.customBaseUrl
                ? { baseUrl: apiConfig.customBaseUrl }
                : {}),
            }),
          });
          const json = (await res.json()) as {
            apiKey?: string;
            message?: string;
          };
          if (!res.ok || !json.apiKey) {
            throw new Error(
              json.message || "Error de autenticación con el servidor."
            );
          }
          return json.apiKey;
        },
      });

      const realtimeClient = await client.realtime.connect(inputStream, {
        model: modelDef,
        resolution: apiConfig.resolution,
        speed:
          fastMode && currentModelInfo.supportsFast ? "fast" : undefined,
        mirror: serverMirrorValue,
        preferredVideoCodec: apiConfig.preferredVideoCodec,
        retries: apiConfig.retries,
        capacityRetryBudgetMs: apiConfig.capacityRetryBudgetMs,
        debugQuality: apiConfig.debugQuality,
        onRemoteStream: (transformedStream) => {
          broadcastOutputStreamChange(transformedStream);
          setHasOutputStream(true);
        },
        onConnectionQuality: (report) => {
          setTelemetry((prev) => ({
            ...prev,
            decartQuality: report.quality,
            decartLimitingFactor: report.limitingFactor,
          }));
        },
        onCapacityWait: ({ retryAfterMs }) => {
          setDecartStatusNote(
            `Cola de GPU ocupada, reintentando en ${Math.max(
              1,
              Math.round(retryAfterMs / 1000)
            )}s...`
          );
        },
        initialState: {
          passthrough: apiConfig.passthroughOnStart,
          prompt: {
            text: promptText.trim() || FACE_PRESETS[0].recommendedPrompt,
            enhance: enhancePrompt,
          },
          ...(referenceFile ? { image: referenceFile } : {}),
        },
      });

      realtimeClientRef.current = realtimeClient;

      realtimeClient.on("connectionChange", (state) => {
        if (state === "generating" || state === "connected") {
          setDecartPhase("generating");
          setDecartStatusNote(null);
        } else if (state === "reconnecting") {
          setDecartPhase("reconnecting");
          setDecartStatusNote("Reconectando flujo...");
        } else if (state === "disconnected") {
          setDecartPhase("idle");
        }
      });

      realtimeClient.on("stats", (stats) => {
        setTelemetry((prev) => ({
          ...prev,
          decartTtffMs:
            typeof stats.glassToGlass?.ttffMs === "number"
              ? Math.round(stats.glassToGlass.ttffMs)
              : prev.decartTtffMs,
          decartG2gMs:
            typeof stats.glassToGlass?.medianMs === "number"
              ? Math.round(stats.glassToGlass.medianMs)
              : prev.decartG2gMs,
          decartFps:
            typeof stats.video?.framesPerSecond === "number"
              ? Math.round(stats.video.framesPerSecond)
              : prev.decartFps,
        }));
      });

      realtimeClient.on("error", (err) => {
        setDecartError(err.message || "Error en la sesión de PANDAFACE.");
      });

      realtimeClient.on("sessionEnded", ({ reason }) => {
        if (reason === "insufficient_credits") {
          const nextExhausted = { ...exhaustedSlots, [selectedKeySlot]: true };
          setExhaustedSlots(nextExhausted);

          const backupSlot = keySlots.find(
            (s) => s.id !== selectedKeySlot && s.configured && !nextExhausted[s.id]
          );
          if (backupSlot) {
            setSelectedKeySlot(backupSlot.id);
            setDecartError(
              `Créditos agotados en la cuenta activa. Se cambió a ${backupSlot.label}.`
            );
          } else {
            setDecartError("Todas las cuentas configuradas quedaron sin saldo.");
          }
        } else {
          setDecartError(`Sesión finalizada: ${reason}`);
        }
        stopDecartSession();
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "No se pudo conectar con PANDAFACE.";
      setDecartError(msg);
      stopDecartSession();
      setDecartPhase("error");
    }
  }, [
    activeApiUser,
    apiConfig,
    broadcastOutputStreamChange,
    buildDecartInputStream,
    currentModelInfo.supportsFast,
    enhancePrompt,
    exhaustedSlots,
    fastMode,
    getActiveRawStream,
    keySlots,
    promptText,
    resolveReferenceImageFile,
    selectedKeySlot,
    selectedModel,
    stopDecartSession,
  ]);

  // Hot-swap face reference image & prompt without dropping WebRTC session
  const applyLiveFaceSwap = useCallback(
    async (overrideFile?: File | null, overridePrompt?: string) => {
      const rt = realtimeClientRef.current;
      if (!rt || !rt.isConnected()) return;

      setIsApplyingLive(true);
      setDecartError(null);
      try {
        const fileToUse =
          overrideFile === null
            ? null
            : overrideFile || (await resolveReferenceImageFile());
        const nextPrompt = (overridePrompt ?? promptText).trim();

        if (fileToUse === null) {
          await rt.setImage(null, {
            prompt: nextPrompt || null,
            enhance: enhancePrompt,
            timeout: apiConfig.setImageTimeoutMs,
          });
        } else {
          await rt.set({
            prompt: nextPrompt || undefined,
            enhance: enhancePrompt,
            image: fileToUse ?? null,
          });
        }
      } catch (err) {
        setDecartError(
          err instanceof Error
            ? `No se pudo actualizar en vivo: ${err.message}`
            : "Error actualizando identidad en vivo."
        );
      } finally {
        setIsApplyingLive(false);
      }
    },
    [
      apiConfig.setImageTimeoutMs,
      enhancePrompt,
      promptText,
      resolveReferenceImageFile,
    ]
  );

  // Select a curated studio preset
  const handleSelectPreset = async (preset: FacePreset) => {
    setSelectedPresetId(preset.id);
    setCustomImageFile(null);
    setCustomImagePreview(null);
    setPromptText(preset.recommendedPrompt);

    if (realtimeClientRef.current?.isConnected()) {
      const file = await imageUrlToFile(preset.imageUrl, `${preset.id}.jpg`);
      await applyLiveFaceSwap(file, preset.recommendedPrompt);
    }
  };

  // Handle user uploading their own target face/reference photo (revoking prior object URL)
  const handleFileUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setDecartError("Selecciona un archivo de imagen válido (JPG, PNG, WebP).");
      return;
    }

    if (customImagePreview && customImagePreview.startsWith("blob:")) {
      URL.revokeObjectURL(customImagePreview);
    }
    const previewUrl = URL.createObjectURL(file);
    setCustomImageFile(file);
    setCustomImagePreview(previewUrl);
    setDecartError(null);

    if (realtimeClientRef.current?.isConnected()) {
      await applyLiveFaceSwap(file, promptText);
    }
  };

  // Run network connectivity check
  const handlePreflightCheck = async () => {
    setPreflightResult("Evaluando ruta de red...");
    try {
      const client = createDecartClient({
        ...(apiConfig.customBaseUrl ? { baseUrl: apiConfig.customBaseUrl } : {}),
        ...(apiConfig.customRealtimeUrl
          ? { realtimeBaseUrl: apiConfig.customRealtimeUrl }
          : {}),
        apiKeyProvider: async () => {
          const res = await fetch("/api/decart/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: activeApiUser?.id,
              keySlot: selectedKeySlot,
              model: selectedModel,
              ...(apiConfig.customBaseUrl
                ? { baseUrl: apiConfig.customBaseUrl }
                : {}),
            }),
          });
          const data = (await res.json()) as { apiKey?: string };
          return data.apiKey || "preflight";
        },
      });
      const report = await client.realtime.checkConnectivity();
      setPreflightResult(
        `Red: ${report.quality.toUpperCase()} · Transporte ${report.metrics.transport.toUpperCase()} · RTT ${Math.round(
          report.metrics.rttMs ?? 0
        )} ms`
      );
    } catch {
      setPreflightResult("No se pudo completar el test de red.");
    }
  };

  // Test server-configured account slot live
  const handleTestDecartApi = async (slotOverride?: KeySlotId) => {
    const targetSlot = slotOverride || selectedKeySlot;
    setApiTestStatus({
      state: "testing",
      message: "Verificando conexión...",
    });
    onRefreshHealth();
    try {
      const res = await fetch("/api/decart/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keySlot: targetSlot,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        label?: string;
        latencyMs?: number;
        concurrentLimit?: number | null;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        setApiTestStatus({
          state: "error",
          message: data.message || "Error al verificar la cuenta.",
        });
        return;
      }
      setExhaustedSlots((prev) => {
        if (!prev[targetSlot]) return prev;
        const copy = { ...prev };
        delete copy[targetSlot];
        return copy;
      });
      const details = [
        `${data.label || targetSlot}: OK (${data.latencyMs ?? 0} ms)`,
        data.concurrentLimit !== null && data.concurrentLimit !== undefined
          ? `Sesiones: ${data.concurrentLimit}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setApiTestStatus({ state: "ok", message: details });
    } catch {
      setApiTestStatus({
        state: "error",
        message: "No se pudo verificar el estado de la cuenta.",
      });
    }
  };

  // Capture PNG snapshot from transformed output video
  const handleTakeSnapshot = () => {
    const video = outputVideoRef.current;
    if (!video || video.videoWidth === 0) return;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    const link = document.createElement("a");
    link.download = `pandaface-${Date.now()}.png`;
    link.href = c.toDataURL("image/png");
    link.click();
  };

  // Toggle local WebM recording of the transformed stream
  const handleToggleRecording = () => {
    if (isRecording && recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    const stream = outputStreamRef.current;
    if (!stream) return;

    recordedChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      setIsRecording(false);
      setRecordingSeconds(0);
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      if (blob.size === 0) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pandaface-sesion-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };

    recorder.start(500);
    setIsRecording(true);
    setRecordingSeconds(0);
  };

  useEffect(() => {
    if (!isRecording) return;
    const t = window.setInterval(() => {
      setRecordingSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [isRecording]);

  const sendRemoteMobileCommand = (command: string, value?: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "host-command",
          command,
          value,
        })
      );
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(mobileShareUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const isLucyLive =
    decartPhase === "generating" ||
    decartPhase === "connecting" ||
    decartPhase === "reconnecting";

  return (
    <div className="max-w-[1440px] mx-auto px-4 lg:px-6 py-5 space-y-5">
      {decartConfigured === false && (
        <div className="rounded-xl bg-amber-950/35 border border-amber-500/35 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-100">
          <span>
            Motor PANDAFACE sin cuenta activa en el servidor. Configura{" "}
            <code className="font-mono text-amber-200">DECART_API_KEY</code> en
            el servidor y administra tus usuarios y parámetros en Admin API.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenAdmin}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Abrir Admin API</span>
            </button>
            <button
              type="button"
              onClick={() => void handleTestDecartApi()}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-xs font-semibold text-amber-100 whitespace-nowrap shrink-0"
            >
              Verificar estado
            </button>
          </div>
        </div>
      )}

      {/* Main 2-Column Studio Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        {/* LEFT COLUMN: Dominant Video Stage + Transport Bar + Real Telemetry */}
        <section className="space-y-4 min-w-0">
          {/* Stage Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[#11161F] border border-white/10 rounded-xl px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="flex items-center p-0.5 rounded-lg bg-[#090C10] border border-white/10">
                <button
                  type="button"
                  disabled={
                    activeApiUser
                      ? !activeApiUser.permissions.canUseMobileP2p
                      : false
                  }
                  onClick={() => void handleSelectSource("mobile")}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                    sourceMode === "mobile"
                      ? "bg-blue-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>Celular P2P</span>
                </button>
                <button
                  type="button"
                  disabled={
                    activeApiUser ? !activeApiUser.permissions.canUseUsb : false
                  }
                  onClick={() => void handleSelectSource("usb")}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                    sourceMode === "usb"
                      ? "bg-blue-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <Usb className="w-3.5 h-3.5" />
                  <span>USB (APK)</span>
                  {(adbDevices.some(
                    (d) => d.state === "device" || d.state === "unauthorized"
                  ) ||
                    usbDevices.length > 0 ||
                    usbPhase === "live") && (
                    <span
                      className={`w-2 h-2 rounded-full ${
                        adbDevices.some((d) => d.state === "device") ||
                        usbDevices.some((d) => d.live) ||
                        usbPhase === "live"
                          ? "bg-emerald-400"
                          : "bg-amber-400"
                      }`}
                      title="Dispositivo USB detectado"
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSelectSource("webcam")}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                    sourceMode === "webcam"
                      ? "bg-blue-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <Laptop className="w-3.5 h-3.5" />
                  <span>Webcam PC</span>
                </button>
                <button
                  type="button"
                  disabled={
                    activeApiUser
                      ? !activeApiUser.permissions.canUseWindowCapture
                      : false
                  }
                  onClick={() => void handleSelectSource("window")}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                    sourceMode === "window"
                      ? "bg-blue-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <AppWindow className="w-3.5 h-3.5" />
                  <span>Capturar Ventana</span>
                  {windowCapturePhase === "live" && (
                    <span
                      className="w-2 h-2 rounded-full bg-emerald-400"
                      title="Captura de ventana en vivo"
                    />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center p-0.5 rounded-lg bg-[#090C10] border border-white/10">
                {(
                  [
                    { id: "split", label: "Comparativa" },
                    { id: "output", label: "Solo Salida" },
                    { id: "pip", label: "PiP" },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setLayoutMode(tab.id)}
                    className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      layoutMode === tab.id
                        ? "bg-[#1C2432] text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setMirrorInput((v) => !v)}
                title="Voltear video horizontalmente"
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                  mirrorInput
                    ? "bg-blue-600/20 border-blue-500/40 text-blue-200"
                    : "bg-[#090C10] border-white/10 text-slate-300 hover:text-white"
                }`}
              >
                <FlipHorizontal2 className="w-3.5 h-3.5" />
                <span>Espejo</span>
              </button>

              <button
                type="button"
                onClick={() => void launchSeparateOutputWindow()}
                title="Abrir ventana completa independiente ('PANDAFACE Salida Camara') para SplitCam y WhatsApp"
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 border border-emerald-400/40 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>
                  Ventana SplitCam{outputViewersCount > 0 ? ` (${outputViewersCount})` : ""}
                </span>
              </button>

              <a
                ref={externalOutputAnchorRef}
                href={outputShareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
              >
                Abrir Salida Externa
              </a>

              <button
                type="button"
                onClick={() => onBroadcastModeChange(true)}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <MonitorPlay className="w-3.5 h-3.5" />
                <span>Pantalla Completa</span>
              </button>
            </div>
          </div>

          {/* Dominant Video Monitor */}
          <div className="relative rounded-xl bg-[#0D1118] border border-white/10 overflow-hidden">
            {/* Hidden video element used as source for 16:9 canvas normalizer */}
            <video
              ref={hiddenNormalizeVideoRef}
              className="hidden"
              playsInline
              muted
              autoPlay
            />

            <div
              className={`grid gap-px bg-white/10 ${
                layoutMode === "split"
                  ? "grid-cols-1 md:grid-cols-2"
                  : "grid-cols-1"
              }`}
            >
              {/* Raw Mobile / Webcam Feed */}
              <div
                className={`${
                  layoutMode === "output"
                    ? "hidden"
                    : layoutMode === "pip"
                    ? "absolute bottom-4 right-4 z-20 w-44 sm:w-56 aspect-video rounded-lg overflow-hidden border border-white/25 shadow-2xl bg-black"
                    : "relative aspect-video bg-[#090C10]"
                }`}
              >
                <video
                  ref={rawVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-contain ${
                    mirrorInput ? "-scale-x-100" : ""
                  }`}
                />
                {!hasInputStream && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-2.5">
                    {sourceMode === "window" ? (
                      <AppWindow className="w-8 h-8 text-slate-600" />
                    ) : (
                      <Camera className="w-8 h-8 text-slate-600" />
                    )}
                    <p className="text-xs font-medium text-slate-300">
                      {sourceMode === "mobile"
                        ? "Esperando cámara móvil"
                        : sourceMode === "usb"
                        ? "Esperando cámara USB"
                        : sourceMode === "window"
                        ? windowCapturePhase === "selecting"
                          ? "Elige una ventana o pantalla en el selector..."
                          : "Sin ventana capturada"
                        : "Webcam inactiva"}
                    </p>
                    {sourceMode === "window" && (
                      <button
                        type="button"
                        onClick={() => void startWindowCapture()}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <AppWindow className="w-3.5 h-3.5" />
                        <span>Elegir Ventana</span>
                      </button>
                    )}
                  </div>
                )}

                <div className="absolute top-2.5 left-2.5 px-2 py-1 rounded bg-black/70 backdrop-blur-sm text-[11px] font-medium text-slate-200">
                  Entrada{" "}
                  {sourceMode === "mobile"
                    ? telemetry.p2pResolution || "Celular"
                    : sourceMode === "usb"
                    ? usbResolution
                      ? `USB ${usbResolution}`
                      : "USB Cable"
                    : sourceMode === "window"
                    ? windowCaptureResolution
                      ? `Ventana ${windowCaptureResolution}`
                      : "Ventana PC"
                    : "Webcam"}
                </div>
              </div>

              {/* Transformed Output Feed */}
              <div
                ref={outputStageRef}
                onMouseMove={() => {
                  if (broadcastMode || isOsFullscreen) wakeBroadcastHud();
                }}
                className={
                  broadcastMode || isOsFullscreen
                    ? `fixed inset-0 z-50 w-screen h-screen bg-black flex items-center justify-center ${
                        hudVisible ? "cursor-default" : "cursor-none"
                      }`
                    : `relative aspect-video bg-[#090C10] ${
                        layoutMode === "pip" ? "w-full" : ""
                      }`
                }
              >
                <video
                  ref={outputVideoRef}
                  autoPlay
                  playsInline
                  muted={audioMuted}
                  className={`w-full h-full ${
                    outputFitMode === "cover"
                      ? "object-cover"
                      : "object-contain"
                  } ${mirrorOutputView ? "-scale-x-100" : ""}`}
                />

                {!hasOutputStream && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-3">
                    <Sparkles className="w-8 h-8 text-slate-600" />
                    <p className="text-xs font-medium text-slate-300">
                      {decartPhase === "connecting"
                        ? decartStatusNote || "Conectando PANDAFACE..."
                        : "Salida PANDAFACE en espera"}
                    </p>
                  </div>
                )}

                {/* Normal Studio Labels (hidden completely during Broadcast / Fullscreen for 100% clean OBS capture) */}
                {!broadcastMode && !isOsFullscreen && (
                  <>
                    <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded bg-black/75 backdrop-blur-sm text-[11px] font-medium text-slate-200 flex items-center gap-2">
                      <span>Salida {currentModelInfo.label}</span>
                      {decartPhase === "generating" && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-emerald-400">En Vivo</span>
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void toggleOsFullscreen()}
                      title="Expandir resultado a pantalla completa nativa"
                      className="absolute bottom-2.5 right-2.5 p-2 rounded-lg bg-black/70 hover:bg-black/90 border border-white/15 text-slate-200 hover:text-white transition-colors"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>

                    {isRecording && (
                      <div className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded bg-rose-950/90 border border-rose-500/40 font-mono tabular-nums text-[11px] text-rose-200">
                        REC{" "}
                        {String(Math.floor(recordingSeconds / 60)).padStart(
                          2,
                          "0"
                        )}
                        :{String(recordingSeconds % 60).padStart(2, "0")}
                      </div>
                    )}
                  </>
                )}

                {/* Auto-hiding Controls for Broadcast Window / OS Fullscreen (vanishes in 2s so OBS sees pure video) */}
                {(broadcastMode || isOsFullscreen) && (
                  <div
                    className={`absolute top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-xl bg-black/80 backdrop-blur-md border border-white/15 transition-opacity duration-200 ${
                      hudVisible
                        ? "opacity-100"
                        : "opacity-0 pointer-events-none"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setOutputFitMode((m) =>
                          m === "contain" ? "cover" : "contain"
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white whitespace-nowrap"
                    >
                      {outputFitMode === "contain"
                        ? "Llenar 16:9"
                        : "Ajustar completo"}
                    </button>

                    <button
                      type="button"
                      onClick={() => setMirrorOutputView((m) => !m)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                        mirrorOutputView
                          ? "bg-blue-600 text-white"
                          : "bg-white/10 hover:bg-white/20 text-white"
                      }`}
                    >
                      Espejo
                    </button>

                    <button
                      type="button"
                      onClick={() => setAudioMuted((m) => !m)}
                      className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white whitespace-nowrap"
                    >
                      {audioMuted ? "Audio Off" : "Audio On"}
                    </button>

                    <button
                      type="button"
                      onClick={() => void toggleOsFullscreen()}
                      className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
                    >
                      {isOsFullscreen ? (
                        <>
                          <Minimize2 className="w-3.5 h-3.5" />
                          <span>Salir Fullscreen</span>
                        </>
                      ) : (
                        <>
                          <Maximize2 className="w-3.5 h-3.5" />
                          <span>Fullscreen OS</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (document.fullscreenElement) {
                          void document.exitFullscreen();
                        }
                        onBroadcastModeChange(false);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white whitespace-nowrap"
                    >
                      Volver al Estudio
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Transport & Recording Controls */}
            <div className="px-4 py-3 bg-[#11161F] border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    if (isLucyLive) {
                      stopDecartSession();
                    } else {
                      void startDecartSession();
                    }
                  }}
                  disabled={!hasInputStream && !isLucyLive}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed ${
                    isLucyLive
                      ? "bg-rose-600 hover:bg-rose-500 text-white"
                      : "bg-blue-600 hover:bg-blue-500 text-white"
                  }`}
                >
                  {isLucyLive ? (
                    <>
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Detener PANDAFACE</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Iniciar Cambio de Rostro</span>
                    </>
                  )}
                </button>

                {decartStatusNote && (
                  <span className="text-xs text-slate-300">
                    {decartStatusNote}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAudioMuted((m) => !m)}
                  className="px-3 py-2 rounded-lg bg-[#090C10] border border-white/10 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 whitespace-nowrap"
                >
                  {audioMuted ? (
                    <VolumeX className="w-3.5 h-3.5" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                  <span>{audioMuted ? "Audio Silenciado" : "Audio Sincronizado"}</span>
                </button>

                <button
                  type="button"
                  disabled={!hasOutputStream}
                  onClick={handleTakeSnapshot}
                  className="px-3 py-2 rounded-lg bg-[#090C10] border border-white/10 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Captura PNG</span>
                </button>

                <button
                  type="button"
                  disabled={
                    (!hasOutputStream && !isRecording) ||
                    Boolean(
                      activeApiUser &&
                        !activeApiUser.permissions.canRecord &&
                        !isRecording
                    )
                  }
                  onClick={handleToggleRecording}
                  className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                    isRecording
                      ? "bg-rose-600/20 border-rose-500/50 text-rose-200"
                      : "bg-[#090C10] border-white/10 text-slate-300 hover:text-white"
                  }`}
                >
                  <Video className="w-3.5 h-3.5" />
                  <span>{isRecording ? "Guardar WebM" : "Grabar"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void openIndependentOutputWindow()}
                  title="Abrir mini ventana flotante Picture-in-Picture"
                  className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                    pipWindowOpen
                      ? "bg-emerald-950/60 border-emerald-500/50 text-emerald-200"
                      : "bg-[#090C10] border-white/10 text-slate-300 hover:text-white"
                  }`}
                >
                  <PictureInPicture2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{pipWindowOpen ? "Cerrar PiP" : "Mini PiP"}</span>
                </button>

                <a
                  href={outputShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 rounded-lg bg-[#090C10] border border-white/10 text-xs font-medium text-emerald-300 hover:text-emerald-200 flex items-center gap-1.5 whitespace-nowrap"
                  title="Abrir salida exclusiva en ventana o pestaña separada / OBS"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>
                    Ventana Aparte{outputViewersCount > 0 ? ` (${outputViewersCount})` : ""}
                  </span>
                </a>

                <button
                  type="button"
                  onClick={() => void handleCopyOutputUrl()}
                  className="px-3 py-2 rounded-lg bg-[#090C10] border border-white/10 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 whitespace-nowrap"
                  title="Copiar enlace exclusivo de salida para OBS Browser Source"
                >
                  {copiedOutputUrl ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>URL Copiada</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>URL Salida</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {decartError && (
            <div
              role="alert"
              className="rounded-xl bg-rose-950/50 border border-rose-500/40 px-4 py-3 text-xs text-rose-200"
            >
              {decartError}
            </div>
          )}

          {/* Measured Real-Time Telemetry Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-xl bg-[#11161F] border border-white/10 px-3.5 py-2.5">
              <div className="text-[11px] text-slate-400">
                {sourceMode === "usb" ? "Tasa USB Cable" : "Latencia Celular → PC"}
              </div>
              <div className="mt-0.5 font-mono tabular-nums text-base font-semibold text-white">
                {sourceMode === "usb"
                  ? usbKbps !== null
                    ? `${(usbKbps / 1000).toFixed(1)} Mb/s`
                    : "—"
                  : telemetry.p2pRttMs !== null
                  ? `${telemetry.p2pRttMs} ms`
                  : "—"}
              </div>
            </div>

            <div className="rounded-xl bg-[#11161F] border border-white/10 px-3.5 py-2.5">
              <div className="text-[11px] text-slate-400">
                {sourceMode === "usb" ? "Entrada USB" : "Entrada P2P"}
              </div>
              <div className="mt-0.5 font-mono tabular-nums text-base font-semibold text-white">
                {sourceMode === "usb"
                  ? usbFps !== null
                    ? `${usbFps} fps`
                    : "—"
                  : telemetry.p2pFps !== null
                  ? `${telemetry.p2pFps} fps`
                  : "—"}
              </div>
            </div>

            <div className="rounded-xl bg-[#11161F] border border-white/10 px-3.5 py-2.5">
              <div className="text-[11px] text-slate-400">Latencia Motor</div>
              <div className="mt-0.5 font-mono tabular-nums text-base font-semibold text-white">
                {telemetry.decartG2gMs !== null
                  ? `${telemetry.decartG2gMs} ms`
                  : "—"}
              </div>
            </div>

            <div className="rounded-xl bg-[#11161F] border border-white/10 px-3.5 py-2.5">
              <div className="text-[11px] text-slate-400">Primer Frame</div>
              <div className="mt-0.5 font-mono tabular-nums text-base font-semibold text-white">
                {telemetry.decartTtffMs !== null
                  ? `${telemetry.decartTtffMs} ms`
                  : "—"}
              </div>
            </div>

            <div className="rounded-xl bg-[#11161F] border border-white/10 px-3.5 py-2.5">
              <div className="text-[11px] text-slate-400">Salida PANDAFACE</div>
              <div className="mt-0.5 font-mono tabular-nums text-base font-semibold text-white">
                {telemetry.decartFps !== null
                  ? `${telemetry.decartFps} fps`
                  : "—"}
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Control Rail (Pairing, Model, Face Swap Reference) */}
        <aside className="space-y-4">
          {/* 01. Mobile Pairing OR USB CamLink Card */}
          {sourceMode === "usb" ? (
            <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">
                  01. Cámara USB (APK CamLink)
                </h2>
                <span
                  className={`text-xs font-medium whitespace-nowrap ${
                    usbPhase === "live"
                      ? "text-emerald-400"
                      : usbPhase === "reconnecting"
                      ? "text-amber-300"
                      : usbPhase === "error"
                      ? "text-rose-400"
                      : usbPhase === "connecting" || usbPhase === "discovering"
                      ? "text-blue-400"
                      : "text-slate-400"
                  }`}
                >
                  {usbPhase === "live"
                    ? "USB en vivo"
                    : usbPhase === "reconnecting"
                    ? "Reconectando..."
                    : usbPhase === "connecting"
                    ? "Conectando..."
                    : usbPhase === "discovering"
                    ? "Buscando..."
                    : usbPhase === "error"
                    ? "Sin enlace"
                    : "Listo para USB"}
                </span>
              </div>

              {/* UsbDeviceDetector: WebUSB navigator.usb.getDevices() + 5s ADB scan */}
              <UsbDeviceDetector
                usbDevices={usbDevices}
                usbLiveDevice={usbLiveDevice}
                usbPhase={usbPhase}
                usbFfmpegAvailable={usbFfmpegAvailable}
                adbDevices={adbDevices}
                adbInstalled={adbInstalled}
                onSelectDevice={(dev) => {
                  setUsbLiveDevice(dev);
                  setUsbHost(dev.ip);
                  setUsbPort(dev.port);
                  if (dev.live) {
                    connectUsbCamera(dev.ip, dev.port);
                  } else {
                    setUsbStatusNote(
                      `Móvil en espera (${dev.ip}). Pulsa 'Transmitir' en CamLink USB.`
                    );
                    void discoverUsbDevices(true);
                  }
                }}
                onRescanNetworkUsb={() => void discoverUsbDevices(false)}
              />

              <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                <div>
                  <label
                    htmlFor="usb-host-input"
                    className="block text-[11px] text-slate-400 mb-1"
                  >
                    IP USB / ADB Host
                  </label>
                  <input
                    id="usb-host-input"
                    type="text"
                    value={usbHost}
                    onChange={(e) => setUsbHost(e.target.value)}
                    placeholder="192.168.42.129 o 127.0.0.1"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="usb-port-input"
                    className="block text-[11px] text-slate-400 mb-1"
                  >
                    Puerto
                  </label>
                  <input
                    id="usb-port-input"
                    type="number"
                    min={1024}
                    max={65534}
                    value={usbPort}
                    onChange={(e) =>
                      setUsbPort(
                        Math.min(
                          65534,
                          Math.max(1024, Number(e.target.value) || 7878)
                        )
                      )
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono tabular-nums text-xs text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Hybrid Pipeline Selector + PC Rotation */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Pipeline de video
                  </label>
                  <div className="grid grid-cols-3 gap-1 bg-[#090C10] p-0.5 rounded-lg border border-white/10">
                    {(
                      [
                        { id: "auto", label: "Auto" },
                        { id: "ffmpeg", label: "H264" },
                        { id: "mjpeg", label: "MJPEG" },
                      ] as Array<{ id: UsbPipelinePreference; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setUsbPipelinePref(opt.id);
                          if (
                            usbPhase === "live" ||
                            usbPhase === "reconnecting"
                          ) {
                            connectUsbCamera(undefined, undefined, opt.id);
                          }
                        }}
                        className={`py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                          usbPipelinePref === opt.id
                            ? "bg-blue-600 text-white"
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Rotación PC (GPU)
                  </label>
                  <div className="grid grid-cols-4 gap-1 bg-[#090C10] p-0.5 rounded-lg border border-white/10">
                    {([0, 90, 180, 270] as UsbRotationDeg[]).map((deg) => (
                      <button
                        key={deg}
                        type="button"
                        onClick={() => setUsbRotationDeg(deg)}
                        className={`py-1 rounded font-mono tabular-nums text-[11px] font-medium transition-colors whitespace-nowrap ${
                          usbRotationDeg === deg
                            ? "bg-blue-600 text-white"
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        {deg}°
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void discoverUsbDevices(true)}
                  className="py-2 px-3 rounded-lg bg-[#090C10] hover:bg-[#161D29] border border-white/15 text-xs font-medium text-slate-100 flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Search className="w-3.5 h-3.5 text-blue-400" />
                  <span>Buscar Móvil USB</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      usbPhase === "live" ||
                      usbPhase === "connecting" ||
                      usbPhase === "reconnecting"
                    ) {
                      disconnectUsbCamera();
                    } else {
                      connectUsbCamera();
                    }
                  }}
                  className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap ${
                    usbPhase === "live" ||
                    usbPhase === "connecting" ||
                    usbPhase === "reconnecting"
                      ? "bg-rose-600 hover:bg-rose-500 text-white"
                      : "bg-blue-600 hover:bg-blue-500 text-white"
                  }`}
                >
                  <Usb className="w-3.5 h-3.5" />
                  <span>
                    {usbPhase === "live" ||
                    usbPhase === "connecting" ||
                    usbPhase === "reconnecting"
                      ? "Desconectar"
                      : "Conectar USB"}
                  </span>
                </button>
              </div>

              {usbDevices.length === 0 && usbGateways.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] text-slate-400">
                    Gateways USB / Red detectados en este PC
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {usbGateways.map((gw) => (
                      <button
                        key={gw}
                        type="button"
                        onClick={() => connectUsbCamera(gw, usbPort)}
                        className="px-2.5 py-1 rounded bg-[#090C10] border border-blue-500/40 font-mono tabular-nums text-[11px] text-blue-300 hover:text-white whitespace-nowrap"
                      >
                        Probar {gw}:{usbPort}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Remote Camera Controls sent via HTTP port+1 */}
              <div className="pt-2 border-t border-white/10 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-300 font-medium">
                    Control Remoto CamLink (puerto {usbPort + 1})
                  </span>
                  {usbLiveDevice?.lens && (
                    <span className="font-mono text-slate-400">
                      {usbLiveDevice.lens}
                      {usbLiveDevice.resolution
                        ? ` · ${usbLiveDevice.resolution}`
                        : ""}
                      {usbLiveDevice.fps ? ` · ${usbLiveDevice.fps}fps` : ""}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    disabled={usbRemoteBusy}
                    onClick={() => void sendUsbRemoteCommand("flip")}
                    className="py-1.5 px-2 rounded bg-[#090C10] hover:bg-[#161D29] border border-white/10 text-[11px] text-slate-200 flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-50"
                  >
                    <RotateCw className="w-3 h-3 text-blue-400" />
                    <span>Cámara</span>
                  </button>
                  <button
                    type="button"
                    disabled={usbRemoteBusy}
                    onClick={() =>
                      void sendUsbRemoteCommand("torch", "toggle")
                    }
                    className="py-1.5 px-2 rounded bg-[#090C10] hover:bg-[#161D29] border border-white/10 text-[11px] text-slate-200 flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-50"
                  >
                    <Flashlight className="w-3 h-3 text-amber-300" />
                    <span>Linterna</span>
                  </button>
                  <button
                    type="button"
                    disabled={usbRemoteBusy}
                    onClick={() => void sendUsbRemoteCommand("keyframe")}
                    className="py-1.5 px-2 rounded bg-[#090C10] hover:bg-[#161D29] border border-white/10 text-[11px] text-slate-200 flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-50"
                  >
                    <span>IDR Sync</span>
                  </button>
                </div>

                <div className="grid grid-cols-5 gap-1">
                  {(
                    [
                      { label: "480p", action: "resolution", value: "SD_480P" },
                      { label: "720p", action: "resolution", value: "HD_720P" },
                      {
                        label: "1080p",
                        action: "resolution",
                        value: "FHD_1080P",
                      },
                      { label: "30fps", action: "fps", value: "30" },
                      { label: "60fps", action: "fps", value: "60" },
                    ] as const
                  ).map((btn) => (
                    <button
                      key={btn.label}
                      type="button"
                      disabled={usbRemoteBusy}
                      onClick={() =>
                        void sendUsbRemoteCommand(btn.action, btn.value)
                      }
                      className="py-1 px-1.5 rounded bg-[#090C10] hover:bg-[#161D29] border border-white/10 font-mono tabular-nums text-[11px] text-slate-300 hover:text-white whitespace-nowrap disabled:opacity-50"
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>

                {usbRemoteMsg && (
                  <div className="text-[11px] text-slate-300 bg-[#090C10] border border-white/10 rounded px-2.5 py-1.5 leading-relaxed">
                    {usbRemoteMsg}
                  </div>
                )}
              </div>

              {usbRunningInCloud && (
                <div className="rounded-lg bg-amber-950/40 border border-amber-500/35 px-3 py-2 text-[11px] text-amber-100 leading-relaxed">
                  Ejecuta PANDAFACE en <code className="font-mono">localhost:3000</code> para acceder al cable USB local.
                </div>
              )}

              {usbStatusNote && (
                <div className="rounded-lg bg-[#090C10] border border-white/10 px-3 py-2 text-[11px] text-slate-300 leading-relaxed">
                  {usbStatusNote}
                </div>
              )}
            </div>
          ) : sourceMode === "window" ? (
            <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">
                  01. Capturar Ventana (PC)
                </h2>
                <span
                  className={`text-xs font-medium whitespace-nowrap ${
                    windowCapturePhase === "live"
                      ? "text-emerald-400"
                      : windowCapturePhase === "selecting"
                      ? "text-blue-400"
                      : windowCapturePhase === "error"
                      ? "text-rose-400"
                      : "text-slate-400"
                  }`}
                >
                  {windowCapturePhase === "live"
                    ? "Capturando en vivo"
                    : windowCapturePhase === "selecting"
                    ? "Seleccionando..."
                    : windowCapturePhase === "error"
                    ? "Error"
                    : "Inactiva"}
                </span>
              </div>

              <div className="rounded-lg bg-[#090C10] border border-white/10 px-3 py-2.5 space-y-1">
                <div className="text-[11px] text-slate-400">
                  Fuente de pantalla / ventana activa
                </div>
                <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-100">
                  <span className="truncate">
                    {windowCaptureLabel || "Ninguna ventana seleccionada"}
                  </span>
                  {windowCaptureResolution && (
                    <span className="font-mono tabular-nums text-[11px] text-emerald-300 shrink-0">
                      {windowCaptureResolution}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void startWindowCapture()}
                  className="py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <AppWindow className="w-3.5 h-3.5" />
                  <span>
                    {windowCapturePhase === "live"
                      ? "Cambiar Ventana"
                      : "Elegir Ventana"}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={windowCapturePhase !== "live"}
                  onClick={stopWindowCapture}
                  className="py-2 px-3 rounded-lg bg-[#090C10] hover:bg-[#161D29] border border-white/15 text-xs font-medium text-slate-200 hover:text-white flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-40"
                >
                  <Square className="w-3.5 h-3.5 text-rose-400" />
                  <span>Detener</span>
                </button>
              </div>

              {windowCaptureNote && (
                <div className="rounded-lg bg-[#090C10] border border-white/10 px-3 py-2 text-[11px] text-slate-300 leading-relaxed">
                  {windowCaptureNote}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  01. Enlace Celular (WebRTC)
                </h2>
                <span
                  className={`text-xs font-medium ${
                    peerPhase === "connected"
                      ? "text-emerald-400"
                      : mobileOnline
                      ? "text-blue-400"
                      : "text-slate-400"
                  }`}
                >
                  {peerPhase === "connected"
                    ? "Video en vivo"
                    : mobileOnline
                    ? "Celular en sala"
                    : "Esperando móvil"}
                </span>
              </div>

              <div className="flex items-center gap-3.5">
                <div className="p-2 rounded-lg bg-white shrink-0">
                  <QRCodeSVG value={mobileShareUrl} size={92} level="M" />
                </div>

                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] text-slate-400">Código de Sala</div>
                      <div className="font-mono tabular-nums text-lg font-bold tracking-widest text-white">
                        {roomId}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onRegenerateRoom}
                      title="Generar nuevo código de sala"
                      className="p-2 rounded-lg bg-[#090C10] border border-white/10 text-slate-300 hover:text-white"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleCopyLink()}
                      className="flex-1 px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/10 text-[11px] font-medium text-slate-200 hover:text-white flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      {copiedLink ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span>Copiado</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copiar enlace</span>
                        </>
                      )}
                    </button>
                    <a
                      href={mobileShareUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/10 text-[11px] font-medium text-blue-300 hover:text-blue-200 whitespace-nowrap"
                    >
                      Abrir aquí
                    </a>
                  </div>
                </div>
              </div>

              {/* Remote Camera Controls when phone is connected */}
              {mobileOnline && (
                <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400 truncate">
                    {mobileMeta?.deviceLabel || "Cámara móvil conectada"}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => sendRemoteMobileCommand("flip-camera")}
                      className="px-2 py-1 rounded bg-[#090C10] border border-white/10 text-[11px] text-slate-200 hover:text-white whitespace-nowrap"
                    >
                      Voltear cámara
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        sendRemoteMobileCommand("set-quality", "480p30")
                      }
                      className="px-2 py-1 rounded bg-[#090C10] border border-white/10 text-[11px] text-slate-200 hover:text-white whitespace-nowrap"
                    >
                      480p
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        sendRemoteMobileCommand("set-quality", "720p30")
                      }
                      className="px-2 py-1 rounded bg-[#090C10] border border-white/10 text-[11px] text-slate-200 hover:text-white whitespace-nowrap"
                    >
                      720p
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 02. Model & Pipeline Configuration */}
          <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">
                02. Motor PANDAFACE
              </h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleTestDecartApi()}
                  className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 whitespace-nowrap"
                >
                  {apiTestStatus.state === "testing" ? "Probando..." : "Verificar"}
                </button>
                <button
                  type="button"
                  onClick={() => void handlePreflightCheck()}
                  className="text-[11px] font-medium text-blue-400 hover:text-blue-300 flex items-center gap-1 whitespace-nowrap"
                >
                  <Wifi className="w-3 h-3" />
                  <span>Test de Red</span>
                </button>
              </div>
            </div>

            {/* Active API User Strip */}
            <div className="flex items-center justify-between gap-2 rounded-lg bg-[#090C10] border border-white/10 px-3 py-2 text-[11px]">
              <div className="min-w-0">
                <div className="text-slate-400">Usuario Activo</div>
                <div className="font-medium text-white truncate">
                  {activeApiUser
                    ? `${activeApiUser.name} (${activeApiUser.role.toUpperCase()})`
                    : "Predeterminado del Servidor"}
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenAdmin}
                className="px-2.5 py-1 rounded bg-[#161D29] hover:bg-[#1E2736] border border-white/10 text-[11px] font-medium text-emerald-300 flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <ShieldCheck className="w-3 h-3" />
                <span>Administrar</span>
              </button>
            </div>

            {/* Multi-Slot Server Key Switcher */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Cuenta Activa</span>
                <button
                  type="button"
                  onClick={() => {
                    setExhaustedSlots({});
                    onRefreshHealth();
                  }}
                  className="text-[11px] text-slate-300 hover:text-white flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Recargar</span>
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1 bg-[#090C10] p-1 rounded-lg border border-white/10">
                {keySlots.map((slot, idx) => {
                  const isActive = selectedKeySlot === slot.id;
                  const isDepleted = Boolean(exhaustedSlots[slot.id]);
                  const shortTitle = `Cuenta ${idx + 1}`;
                  return (
                    <button
                      key={slot.id}
                      type="button"
                      onClick={() => {
                        if (slot.id === selectedKeySlot) return;
                        if (isLucyLive) {
                          stopDecartSession();
                          setDecartStatusNote(
                            `Cuenta cambiada a ${shortTitle}.`
                          );
                        }
                        setSelectedKeySlot(slot.id);
                        setApiTestStatus({ state: "idle", message: "" });
                        setDecartError(null);
                      }}
                      className={`py-1.5 px-2 rounded-md text-left transition-colors ${
                        isActive
                          ? "bg-[#1C2432] text-white"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <div className="text-[11px] font-medium leading-tight truncate">
                        {shortTitle}
                      </div>
                      <div
                        className={`text-[10px] leading-tight mt-0.5 ${
                          isDepleted
                            ? "text-amber-400"
                            : slot.configured
                            ? "text-emerald-400"
                            : "text-slate-500"
                        }`}
                      >
                        {isDepleted
                          ? "Sin saldo"
                          : slot.configured
                          ? "Lista"
                          : "Vacía"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* All Available Realtime API Model Versions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400">
                  Versión de Modelo API
                </span>
                <div className="flex items-center gap-1 bg-[#090C10] p-0.5 rounded-md border border-white/10">
                  {(
                    [
                      { id: "all", label: "Todos" },
                      { id: "edit", label: "Edit" },
                      { id: "restyle", label: "Restyle" },
                      { id: "vton", label: "Try-On" },
                    ] as const
                  ).map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setModelCategoryFilter(cat.id)}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        modelCategoryFilter === cat.id
                          ? "bg-[#1C2432] text-white"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 bg-[#090C10] p-1.5 rounded-lg border border-white/10 max-h-56 overflow-y-auto">
                {LUCY_MODELS.filter(
                  (m) =>
                    modelCategoryFilter === "all" ||
                    m.category === modelCategoryFilter
                ).map((m) => {
                  const isAllowed = activeApiUser
                    ? activeApiUser.allowedModels.includes(m.id)
                    : true;
                  const active = selectedModel === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={isLucyLive || !isAllowed}
                      onClick={() => setSelectedModel(m.id)}
                      className={`px-2.5 py-2 rounded-md text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed border ${
                        active
                          ? "bg-blue-600/20 border-blue-500 text-white"
                          : "bg-[#11161F]/70 border-white/5 text-slate-300 hover:border-white/20 hover:text-white"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[11px] font-semibold truncate">
                          {m.label}
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 shrink-0">
                          {m.versionTag}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                        {m.badge}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              {currentModelInfo.summary}
            </p>

            <div className="space-y-2 pt-1">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-slate-200">
                    Fast Mode (Baja Latencia)
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {currentModelInfo.supportsFast
                      ? "Prioridad de respuesta rápida"
                      : "Modo estándar"}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={fastMode && currentModelInfo.supportsFast}
                  disabled={!currentModelInfo.supportsFast || isLucyLive}
                  onChange={(e) => setFastMode(e.target.checked)}
                  className="w-4 h-4 accent-blue-600 rounded"
                />
              </label>

              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-slate-200">
                    Normalizar cuadro 1280×720 (16:9)
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={normalize16x9}
                  disabled={isLucyLive}
                  onChange={(e) => setNormalize16x9(e.target.checked)}
                  className="w-4 h-4 accent-blue-600 rounded"
                />
              </label>

              {normalize16x9 && (
                <div className="flex items-center justify-between text-[11px] text-slate-400 pl-0.5">
                  <span>Encuadre 16:9</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={isLucyLive}
                      onClick={() => setFitMode("cover")}
                      className={`px-2 py-0.5 rounded ${
                        fitMode === "cover"
                          ? "bg-[#1C2432] text-white"
                          : "text-slate-400"
                      }`}
                    >
                      Llenar
                    </button>
                    <button
                      type="button"
                      disabled={isLucyLive}
                      onClick={() => setFitMode("contain")}
                      className={`px-2 py-0.5 rounded ${
                        fitMode === "contain"
                          ? "bg-[#1C2432] text-white"
                          : "text-slate-400"
                      }`}
                    >
                      Ajustar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Expandable Adjustable Motor Parameters */}
            <div className="pt-2 border-t border-white/10">
              <button
                type="button"
                disabled={
                  activeApiUser
                    ? !activeApiUser.permissions.canEditEngineSettings
                    : false
                }
                onClick={() => setShowApiSettings((s) => !s)}
                className="w-full flex items-center justify-between py-1 text-xs font-medium text-slate-200 hover:text-white disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <span className="flex items-center gap-1.5">
                  <Settings2 className="w-3.5 h-3.5 text-blue-400" />
                  <span>Ajustes del Motor</span>
                </span>
                <span className="text-[11px] text-slate-400">
                  {activeApiUser && !activeApiUser.permissions.canEditEngineSettings
                    ? "Bloqueado por Admin"
                    : showApiSettings
                    ? "Ocultar"
                    : `${apiConfig.resolution} · ${apiConfig.preferredVideoCodec.toUpperCase()}`}
                </span>
              </button>

              {showApiSettings &&
                (!activeApiUser ||
                  activeApiUser.permissions.canEditEngineSettings) && (
                <div className="mt-3 space-y-3 pt-3 border-t border-white/10 text-xs">
                  {/* Resolution & Codec */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Resolución
                      </label>
                      <div className="grid grid-cols-2 gap-1 bg-[#090C10] p-0.5 rounded-lg border border-white/10">
                        {(["720p", "1080p"] as DecartResolution[]).map((res) => (
                          <button
                            key={res}
                            type="button"
                            disabled={isLucyLive}
                            onClick={() =>
                              setApiConfig((c) => ({ ...c, resolution: res }))
                            }
                            className={`py-1 rounded text-[11px] font-medium disabled:opacity-60 ${
                              apiConfig.resolution === res
                                ? "bg-blue-600 text-white"
                                : "text-slate-400 hover:text-white"
                            }`}
                          >
                            {res}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Códec WebRTC
                      </label>
                      <div className="grid grid-cols-3 gap-1 bg-[#090C10] p-0.5 rounded-lg border border-white/10">
                        {(["h264", "vp8", "vp9"] as DecartCodec[]).map(
                          (codec) => (
                            <button
                              key={codec}
                              type="button"
                              disabled={isLucyLive}
                              onClick={() =>
                                setApiConfig((c) => ({
                                  ...c,
                                  preferredVideoCodec: codec,
                                }))
                              }
                              className={`py-1 rounded text-[11px] font-medium uppercase disabled:opacity-60 ${
                                apiConfig.preferredVideoCodec === codec
                                  ? "bg-blue-600 text-white"
                                  : "text-slate-400 hover:text-white"
                              }`}
                            >
                              {codec}
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Server Mirror */}
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Espejo de salida
                    </label>
                    <div className="grid grid-cols-3 gap-1 bg-[#090C10] p-0.5 rounded-lg border border-white/10">
                      {(
                        [
                          { id: "off", label: "Desactivado" },
                          { id: "auto", label: "Auto" },
                          { id: "always", label: "Siempre" },
                        ] as Array<{ id: DecartMirrorMode; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={isLucyLive}
                          onClick={() =>
                            setApiConfig((c) => ({
                              ...c,
                              serverMirror: opt.id,
                            }))
                          }
                          className={`py-1 rounded text-[11px] font-medium disabled:opacity-60 ${
                            apiConfig.serverMirror === opt.id
                              ? "bg-[#1C2432] text-white"
                              : "text-slate-400 hover:text-white"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Token TTL & Session Limit */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label
                        htmlFor="api-token-ttl"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        TTL Token (60–3600s)
                      </label>
                      <input
                        id="api-token-ttl"
                        type="number"
                        min={60}
                        max={3600}
                        step={30}
                        disabled={isLucyLive}
                        value={apiConfig.tokenTtlSeconds}
                        onChange={(e) =>
                          setApiConfig((c) => ({
                            ...c,
                            tokenTtlSeconds: Math.min(
                              3600,
                              Math.max(60, Number(e.target.value) || 300)
                            ),
                          }))
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono tabular-nums text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="api-max-session"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        Límite sesión (0 = libre)
                      </label>
                      <input
                        id="api-max-session"
                        type="number"
                        min={0}
                        max={7200}
                        step={30}
                        disabled={isLucyLive}
                        value={apiConfig.maxSessionSeconds}
                        onChange={(e) =>
                          setApiConfig((c) => ({
                            ...c,
                            maxSessionSeconds: Math.min(
                              7200,
                              Math.max(0, Number(e.target.value) || 0)
                            ),
                          }))
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono tabular-nums text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
                      />
                    </div>
                  </div>

                  {/* Retries & Timeouts */}
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label
                        htmlFor="api-retries"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        Reintentos
                      </label>
                      <input
                        id="api-retries"
                        type="number"
                        min={0}
                        max={5}
                        disabled={isLucyLive}
                        value={apiConfig.retries}
                        onChange={(e) =>
                          setApiConfig((c) => ({
                            ...c,
                            retries: Math.min(
                              5,
                              Math.max(0, Number(e.target.value) || 0)
                            ),
                          }))
                        }
                        className="w-full px-2 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono tabular-nums text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="api-capacity-budget"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        Espera GPU (s)
                      </label>
                      <input
                        id="api-capacity-budget"
                        type="number"
                        min={0}
                        max={120}
                        disabled={isLucyLive}
                        value={Math.round(apiConfig.capacityRetryBudgetMs / 1000)}
                        onChange={(e) =>
                          setApiConfig((c) => ({
                            ...c,
                            capacityRetryBudgetMs:
                              Math.min(120, Math.max(0, Number(e.target.value) || 0)) *
                              1000,
                          }))
                        }
                        className="w-full px-2 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono tabular-nums text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="api-image-timeout"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        Timeout Img (s)
                      </label>
                      <input
                        id="api-image-timeout"
                        type="number"
                        min={5}
                        max={30}
                        value={Math.round(apiConfig.setImageTimeoutMs / 1000)}
                        onChange={(e) =>
                          setApiConfig((c) => ({
                            ...c,
                            setImageTimeoutMs:
                              Math.min(30, Math.max(5, Number(e.target.value) || 15)) *
                              1000,
                          }))
                        }
                        className="w-full px-2 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono tabular-nums text-xs text-white focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  {/* Passthrough toggle */}
                  <div className="space-y-1.5">
                    <label className="flex items-center justify-between gap-2 cursor-pointer">
                      <span className="text-[11px] text-slate-300">
                        Iniciar en Passthrough (sin editar)
                      </span>
                      <input
                        type="checkbox"
                        disabled={isLucyLive}
                        checked={apiConfig.passthroughOnStart}
                        onChange={(e) =>
                          setApiConfig((c) => ({
                            ...c,
                            passthroughOnStart: e.target.checked,
                          }))
                        }
                        className="w-3.5 h-3.5 accent-blue-600 rounded"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void handleTestDecartApi()}
                      className="py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-[11px] font-semibold text-white flex items-center justify-center gap-1.5"
                    >
                      <span>
                        {apiTestStatus.state === "testing"
                          ? "Probando..."
                          : "Verificar Motor"}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={isLucyLive}
                      onClick={() => setApiConfig(DEFAULT_DECART_API_CONFIG)}
                      className="py-1.5 px-3 rounded-lg bg-[#090C10] border border-white/10 text-[11px] font-medium text-slate-300 hover:text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Restablecer</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {apiTestStatus.state !== "idle" && (
              <div
                className={`rounded-lg border px-3 py-2 font-mono text-[11px] ${
                  apiTestStatus.state === "ok"
                    ? "bg-emerald-950/35 border-emerald-500/40 text-emerald-200"
                    : apiTestStatus.state === "error"
                    ? "bg-rose-950/40 border-rose-500/40 text-rose-200"
                    : "bg-[#090C10] border-white/10 text-slate-300"
                }`}
              >
                {apiTestStatus.message}
              </div>
            )}

            {preflightResult && (
              <div className="rounded-lg bg-[#090C10] border border-white/10 px-3 py-2 font-mono text-[11px] text-slate-300">
                {preflightResult}
              </div>
            )}
          </div>

          {/* 03. Target Face Reference & Live Prompt Swap */}
          <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                03. Rostro de Referencia
              </h2>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs font-medium text-blue-400 hover:text-blue-300 flex items-center gap-1 whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Subir foto</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => void handleFileUpload(e.target.files?.[0])}
              />
            </div>

            {/* Preset Portraits Grid + Custom Upload Preview */}
            <div className="grid grid-cols-4 gap-2">
              {FACE_PRESETS.map((preset) => {
                const isSelected =
                  !customImagePreview && selectedPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => void handleSelectPreset(preset)}
                    className={`group relative aspect-square rounded-lg overflow-hidden border transition-all ${
                      isSelected
                        ? "border-blue-500 ring-2 ring-blue-500/40"
                        : "border-white/10 hover:border-white/30"
                    }`}
                  >
                    <img
                      src={preset.imageUrl}
                      alt={preset.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 py-1 text-[10px] font-medium text-white truncate text-left">
                      {preset.name.split(" ")[0]}
                    </div>
                  </button>
                );
              })}
            </div>

            {customImagePreview && (
              <div className="flex items-center justify-between gap-3 p-2 rounded-lg bg-[#090C10] border border-blue-500/40">
                <div className="flex items-center gap-2.5 min-w-0">
                  <img
                    src={customImagePreview}
                    alt="Rostro personalizado"
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-white truncate">
                      {customImageFile?.name || "Foto personalizada"}
                    </div>
                    <div className="text-[11px] text-blue-300">
                      Identidad activa
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCustomImageFile(null);
                    setCustomImagePreview(null);
                  }}
                  className="text-[11px] text-slate-400 hover:text-white px-2 py-1"
                >
                  Quitar
                </button>
              </div>
            )}

            {/* Drag & Drop Mini Target */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFileUpload(e.dataTransfer.files?.[0]);
              }}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-dashed border-white/15 bg-[#090C10]/60 px-3 py-2.5 flex items-center justify-center gap-2 text-[11px] text-slate-400 hover:text-slate-200 hover:border-white/30 cursor-pointer transition-colors"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              <span>Cargar imagen de referencia</span>
            </div>

            {/* Prompt & Enhance */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="lucy-prompt"
                  className="text-xs font-medium text-slate-300"
                >
                  Prompt
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enhancePrompt}
                    onChange={(e) => setEnhancePrompt(e.target.checked)}
                    className="w-3.5 h-3.5 accent-blue-600 rounded"
                  />
                  <span>Enhance</span>
                </label>
              </div>

              <textarea
                id="lucy-prompt"
                rows={3}
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                className="w-full rounded-lg bg-[#090C10] border border-white/15 px-3 py-2 text-xs text-slate-100 leading-relaxed focus:outline-none focus:border-blue-500 resize-none"
              />

              <div className="flex flex-wrap gap-1.5">
                {PROMPT_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    type="button"
                    onClick={() => setPromptText(tpl.text)}
                    className="px-2 py-1 rounded bg-[#090C10] border border-white/10 text-[11px] text-slate-300 hover:text-white hover:border-white/25 transition-colors"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!isLucyLive || isApplyingLive}
                onClick={() => void applyLiveFaceSwap()}
                className="py-2.5 px-3 rounded-lg bg-[#1A2332] hover:bg-[#222D40] border border-white/10 text-xs font-semibold text-white flex items-center justify-center gap-1.5 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>
                  {isApplyingLive ? "Aplicando..." : "Aplicar en Vivo"}
                </span>
              </button>

              <button
                type="button"
                disabled={!isLucyLive || isApplyingLive}
                onClick={() => void applyLiveFaceSwap(null)}
                className="py-2.5 px-3 rounded-lg bg-[#090C10] hover:bg-[#141A23] border border-white/10 text-xs font-medium text-slate-300 hover:text-white flex items-center justify-center gap-1.5 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <span>Quitar rostro</span>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
