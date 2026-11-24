export type LucyModelId = "lucy-2.5" | "lucy-2.1" | "lucy-2.6" | "lucy-latest";

export type VideoSourceMode = "mobile" | "usb" | "webcam";
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
  label: string;
  badge: string;
  supportsFast: boolean;
  summary: string;
}> = [
  {
    id: "lucy-2.5",
    label: "Panda V2.5",
    badge: "720p · Rápido",
    supportsFast: true,
    summary:
      "Motor equilibrado en tiempo real con respuesta rápida.",
  },
  {
    id: "lucy-2.1",
    label: "Panda V2.1",
    badge: "720p · Personaje",
    supportsFast: false,
    summary:
      "Enfocado en intercambio de personajes e identidad.",
  },
  {
    id: "lucy-2.6",
    label: "Panda V2.6",
    badge: "720p · Alta Fidelidad",
    supportsFast: true,
    summary:
      "Mayor fidelidad facial y sincronía labial.",
  },
  {
    id: "lucy-latest",
    label: "Panda Auto",
    badge: "Auto",
    supportsFast: true,
    summary:
      "Selección automática del motor más reciente.",
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

