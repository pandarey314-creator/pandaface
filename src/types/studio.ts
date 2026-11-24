export type LucyModelCategory = "edit" | "restyle" | "vton";

export type LucyModelId =
  | "lucy-2.6"
  | "lucy-2.5"
  | "lucy-2.1"
  | "lucy-latest"
  | "lucy-restyle-2"
  | "lucy-restyle-latest"
  | "lucy-vton-3.6"
  | "lucy-vton-3.5"
  | "lucy-vton-latest";

export type VideoSourceMode = "mobile" | "usb" | "webcam" | "window";
export type ViewLayoutMode = "output" | "split" | "pip";

export type UsbCamPhase =
  | "idle"
  | "discovering"
  | "connecting"
  | "reconnecting"
  | "live"
  | "error";

export type UsbPipelinePreference = "auto" | "ffmpeg" | "mjpeg";
export type UsbRotationDeg = 0 | 90 | 180 | 270;

export interface UsbCamDevice {
  ip: string;
  port: number;
  ctrlPort: number;
  live: boolean;
  restarting?: boolean;
  proto: string;
  via: "adb" | "usb-tethering" | "udp" | "bridge" | "manual";
  deviceName?: string;
  lens?: "BACK" | "FRONT" | string;
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

export interface AdbScannedDevice {
  serial: string;
  state: "device" | "unauthorized" | "offline" | string;
  model?: string;
  product?: string;
  forwarded: boolean;
  camLinkLive?: boolean;
  camLinkProto?: string;
  camLinkPort?: number;
}

export type PeerConnectionPhase =
  | "idle"
  | "waiting"
  | "signaling"
  | "connected"
  | "disconnected"
  | "error";

export type DecartSessionPhase =
  | "idle"
  | "connecting"
  | "generating"
  | "reconnecting"
  | "error";

export interface MobileStreamMeta {
  deviceLabel?: string;
  width?: number;
  height?: number;
  fps?: number;
  facingMode?: "user" | "environment";
  mirrored?: boolean;
}

export interface StudioTelemetry {
  p2pRttMs: number | null;
  p2pFps: number | null;
  p2pBitrateKbps: number | null;
  p2pResolution: string | null;
  decartTtffMs: number | null;
  decartG2gMs: number | null;
  decartFps: number | null;
  decartQuality: "good" | "fair" | "poor" | "critical" | null;
  decartLimitingFactor: string | null;
}

export interface FacePreset {
  id: string;
  name: string;
  subtitle: string;
  imageUrl: string;
  recommendedPrompt: string;
}

export const FACE_PRESETS: FacePreset[] = [
  {
    id: "noir-actor",
    name: "Julián Vance",
    subtitle: "Retrato editorial masculino",
    imageUrl: "/src/assets/images/face_preset_noir_actor_1795226350894.jpg",
    recommendedPrompt:
      "Replace the person's face and hairstyle with the exact identity from the reference image, matching original lighting, natural skin pores, facial expressions, and background seamlessly.",
  },
  {
    id: "editorial-woman",
    name: "Elena Rostova",
    subtitle: "Retrato estudio femenino",
    imageUrl: "/src/assets/images/face_preset_editorial_woman_1795226348163.jpg",
    recommendedPrompt:
      "Swap only the person's face and hair to match the woman in the reference image accurately, preserving natural head rotation, lip sync, studio lighting, and clothing.",
  },
  {
    id: "cyber-character",
    name: "Kaelen Vex",
    subtitle: "Personaje sci-fi estilizado",
    imageUrl: "/src/assets/images/face_preset_cyber_character_1795226350758.jpg",
    recommendedPrompt:
      "Transform the speaker's face into the sci-fi character in the reference image, keeping subtle metallic temple circuitry and amber eyes while preserving real-time expressions and background.",
  },
  {
    id: "classic-painter",
    name: "Arthur Sterling",
    subtitle: "Retrato clásico con barba",
    imageUrl: "/src/assets/images/face_preset_classic_painter_1795226351478.jpg",
    recommendedPrompt:
      "Replace the person's face with the older bearded man from the reference image, preserving natural wrinkles, beard texture, realistic lighting, and exact mouth movement.",
  },
];

export const LUCY_MODELS: Array<{
  id: LucyModelId;
  category: LucyModelCategory;
  label: string;
  versionTag: string;
  badge: string;
  supportsFast: boolean;
  summary: string;
}> = [
  {
    id: "lucy-2.6",
    category: "edit",
    label: "Panda Edit v2.6",
    versionTag: "lucy-2.6",
    badge: "720p/1080p · Fast",
    supportsFast: true,
    summary:
      "Edición facial e identidad en tiempo real v2.6 de máxima fidelidad y sincronía labial.",
  },
  {
    id: "lucy-2.5",
    category: "edit",
    label: "Panda Edit v2.5",
    versionTag: "lucy-2.5",
    badge: "720p · Fast",
    supportsFast: true,
    summary:
      "Motor equilibrado en tiempo real v2.5 con baja latencia y estabilidad continua.",
  },
  {
    id: "lucy-2.1",
    category: "edit",
    label: "Panda Edit v2.1",
    versionTag: "lucy-2.1",
    badge: "720p · Clásico",
    supportsFast: false,
    summary:
      "Versión clásica v2.1 orientada a cambio de personaje e identidad estable.",
  },
  {
    id: "lucy-latest",
    category: "edit",
    label: "Panda Edit Latest",
    versionTag: "lucy-latest",
    badge: "Auto · Fast",
    supportsFast: true,
    summary:
      "Alias dinámico que apunta automáticamente a la versión de edición más reciente en la API.",
  },
  {
    id: "lucy-restyle-2",
    category: "restyle",
    label: "Panda Restyle v2",
    versionTag: "lucy-restyle-2",
    badge: "Estilo Vivo · 30fps",
    supportsFast: false,
    summary:
      "Transformación de estilo visual y ambientación completa en tiempo real mediante prompt o referencia.",
  },
  {
    id: "lucy-restyle-latest",
    category: "restyle",
    label: "Panda Restyle Latest",
    versionTag: "lucy-restyle-latest",
    badge: "Auto · Estilo",
    supportsFast: false,
    summary:
      "Alias automático hacia la versión más nueva de Restyle en tiempo real de la API.",
  },
  {
    id: "lucy-vton-3.6",
    category: "vton",
    label: "Panda Try-On v3.6",
    versionTag: "lucy-vton-3.6",
    badge: "VTON 3.6 · Fast",
    supportsFast: true,
    summary:
      "Prueba virtual de vestuario y apariencia v3.6 en video en vivo con soporte Fast Mode.",
  },
  {
    id: "lucy-vton-3.5",
    category: "vton",
    label: "Panda Try-On v3.5",
    versionTag: "lucy-vton-3.5",
    badge: "VTON 3.5 · Fast",
    supportsFast: true,
    summary:
      "Versión v3.5 para prueba virtual de prendas y cambios de estilo en vivo.",
  },
  {
    id: "lucy-vton-latest",
    category: "vton",
    label: "Panda Try-On Latest",
    versionTag: "lucy-vton-latest",
    badge: "Auto · VTON",
    supportsFast: true,
    summary:
      "Alias automático para ejecutar siempre la última versión Try-On disponible en la API.",
  },
];

export type DecartResolution = "720p" | "1080p";
export type DecartCodec = "h264" | "vp8" | "vp9";
export type DecartMirrorMode = "off" | "auto" | "always";

export interface DecartApiConfig {
  resolution: DecartResolution;
  preferredVideoCodec: DecartCodec;
  serverMirror: DecartMirrorMode;
  passthroughOnStart: boolean;
  tokenTtlSeconds: number;
  maxSessionSeconds: number;
  retries: number;
  capacityRetryBudgetMs: number;
  setImageTimeoutMs: number;
  customBaseUrl: string;
  customRealtimeUrl: string;
  debugQuality: boolean;
}

export const DEFAULT_DECART_API_CONFIG: DecartApiConfig = {
  resolution: "720p",
  preferredVideoCodec: "h264",
  serverMirror: "off",
  passthroughOnStart: false,
  tokenTtlSeconds: 300,
  maxSessionSeconds: 0,
  retries: 5,
  capacityRetryBudgetMs: 60000,
  setImageTimeoutMs: 15000,
  customBaseUrl: "",
  customRealtimeUrl: "",
  debugQuality: false,
};

export type KeySlotId = string;

export interface KeySlotInfo {
  id: KeySlotId;
  label: string;
  configured: boolean;
  envVar?: string;
}

export type ApiUserRole = "admin" | "operator" | "viewer";

export interface ApiUserPermissions {
  canUseMobileP2p: boolean;
  canUseUsb: boolean;
  canUseWindowCapture: boolean;
  canRecord: boolean;
  canEditEngineSettings: boolean;
}

export interface ApiUserFunctionalSettings extends DecartApiConfig {
  model: LucyModelId;
  fastMode: boolean;
  enhancePrompt: boolean;
  defaultPrompt: string;
}

export interface ApiUserProfile {
  id: string;
  name: string;
  handle: string;
  role: ApiUserRole;
  enabled: boolean;
  assignedSlotId: KeySlotId;
  allowedModels: LucyModelId[];
  permissions: ApiUserPermissions;
  apiSettings: ApiUserFunctionalSettings;
  createdAt: number;
  updatedAt: number;
  lastAppliedAt: number | null;
}

