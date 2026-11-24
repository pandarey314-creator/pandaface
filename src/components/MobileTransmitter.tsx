import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  FlipHorizontal2,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  Square,
  Zap,
  ZapOff,
  ArrowLeft,
} from "lucide-react";
import {
  RTC_CONFIG,
  getSignalWsUrl,
  prioritizeLowLatencyCodecs,
  tuneVideoSenderForLowLatency,
} from "../lib/webrtcConfig";
import type { PeerConnectionPhase } from "../types/studio";

interface MobileTransmitterProps {
  initialRoomId: string;
  onExitMobile: () => void;
}

type QualityPreset = "720p30" | "720p24" | "480p30";

const QUALITY_MAP: Record<
  QualityPreset,
  { width: number; height: number; fps: number; bitrate: number; label: string }
> = {
  "720p30": {
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_800_000,
    label: "720p · 30fps",
  },
  "720p24": {
    width: 1280,
    height: 720,
    fps: 24,
    bitrate: 2_200_000,
    label: "720p · 24fps",
  },
  "480p30": {
    width: 854,
    height: 480,
    fps: 30,
    bitrate: 1_500_000,
    label: "480p · 30fps",
  },
};

export const MobileTransmitter: React.FC<MobileTransmitterProps> = ({
  initialRoomId,
  onExitMobile,
}) => {
  const [roomInput, setRoomInput] = useState(initialRoomId.toUpperCase());
  const [phase, setPhase] = useState<PeerConnectionPhase>("idle");
  const [hostConnected, setHostConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [quality, setQuality] = useState<QualityPreset>("720p30");
  const [micEnabled, setMicEnabled] = useState(false);
  const [mirrorPreview, setMirrorPreview] = useState(true);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    fps: number | null;
    kbps: number | null;
    rttMs: number | null;
    resolution: string | null;
  }>({ fps: null, kbps: null, rttMs: null, resolution: null });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const prevBytesRef = useRef<{ bytes: number; ts: number } | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {
      // Ignore wakeLock release errors
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // Wake lock optional
    }
  }, []);

  const stopAll = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    pendingCandidatesRef.current = [];
    prevBytesRef.current = null;
    setStreaming(false);
    setHostConnected(false);
    setTorchOn(false);
    setTorchSupported(false);
    setPhase("idle");
    setStats({ fps: null, kbps: null, rttMs: null, resolution: null });
    void releaseWakeLock();
  }, [releaseWakeLock]);

  useEffect(() => {
    return () => {
      stopAll();
    };
  }, [stopAll]);

  const sendSignal = useCallback((payload: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const publishMeta = useCallback(
    (stream: MediaStream, activeFacing: "user" | "environment") => {
      const vTrack = stream.getVideoTracks()[0];
      const settings = vTrack?.getSettings();
      sendSignal({
        type: "mobile-meta",
        meta: {
          deviceLabel: vTrack?.label || "Cámara Móvil",
          width: settings?.width || undefined,
          height: settings?.height || undefined,
          fps: settings?.frameRate ? Math.round(settings.frameRate) : undefined,
          facingMode: activeFacing,
          mirrored: activeFacing === "user" && mirrorPreview,
        },
      });
    },
    [mirrorPreview, sendSignal]
  );

  const createAndSendOffer = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    setPhase("signaling");
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    const tunedSdp = prioritizeLowLatencyCodecs(offer.sdp || "");
    await pc.setLocalDescription({ type: offer.type, sdp: tunedSdp });
    sendSignal({
      type: "offer",
      sdp: pc.localDescription,
    });
  }, [sendSignal]);

  const acquireCameraStream = useCallback(
    async (
      targetFacing: "user" | "environment",
      targetQuality: QualityPreset,
      withMic: boolean
    ): Promise<MediaStream> => {
      const preset = QUALITY_MAP[targetQuality];
      const constraints: MediaStreamConstraints = {
        audio: withMic
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : false,
        video: {
          facingMode: { ideal: targetFacing },
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.fps, max: preset.fps },
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        try {
          const caps = vTrack.getCapabilities() as MediaTrackCapabilities & {
            torch?: boolean;
          };
          setTorchSupported(Boolean(caps?.torch));
        } catch {
          setTorchSupported(false);
        }
      }
      return stream;
    },
    []
  );

  const setupPeerConnection = useCallback(
    (stream: MediaStream, preset: (typeof QUALITY_MAP)[QualityPreset]) => {
      if (pcRef.current) {
        pcRef.current.close();
      }
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: "ice-candidate",
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") {
          setPhase("connected");
          void tuneVideoSenderForLowLatency(pc, preset.bitrate, preset.fps);
        } else if (st === "connecting") {
          setPhase("signaling");
        } else if (st === "disconnected" || st === "failed") {
          setPhase("error");
        }
      };

      return pc;
    },
    [sendSignal]
  );

  const switchCameraTrack = useCallback(
    async (
      nextFacing: "user" | "environment",
      nextQuality: QualityPreset,
      nextMic: boolean
    ) => {
      try {
        setErrorMsg(null);
        const newStream = await acquireCameraStream(
          nextFacing,
          nextQuality,
          nextMic
        );
        const oldStream = streamRef.current;
        streamRef.current = newStream;

        if (videoRef.current) {
          videoRef.current.srcObject = newStream;
        }

        const pc = pcRef.current;
        const newVideoTrack = newStream.getVideoTracks()[0];
        const newAudioTrack = newStream.getAudioTracks()[0];

        if (pc) {
          const senders = pc.getSenders();
          const vSender = senders.find((s) => s.track?.kind === "video");
          if (vSender && newVideoTrack) {
            await vSender.replaceTrack(newVideoTrack);
          }

          const aSender = senders.find((s) => s.track?.kind === "audio");
          if (aSender) {
            await aSender.replaceTrack(newAudioTrack ?? null);
          } else if (newAudioTrack) {
            pc.addTrack(newAudioTrack, newStream);
            await createAndSendOffer();
          }

          const preset = QUALITY_MAP[nextQuality];
          await tuneVideoSenderForLowLatency(pc, preset.bitrate, preset.fps);
        }

        oldStream?.getTracks().forEach((t) => t.stop());
        setFacingMode(nextFacing);
        setQuality(nextQuality);
        setMicEnabled(nextMic);
        setMirrorPreview(nextFacing === "user");
        setTorchOn(false);
        publishMeta(newStream, nextFacing);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "No se pudo cambiar la configuración de cámara.";
        setErrorMsg(msg);
      }
    },
    [acquireCameraStream, createAndSendOffer, publishMeta]
  );

  const startStreaming = useCallback(async () => {
    const cleanRoom = roomInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(cleanRoom)) {
      setErrorMsg("Ingresa un código de sala válido (4–12 caracteres).");
      return;
    }

    setErrorMsg(null);
    setPhase("waiting");

    try {
      const stream = await acquireCameraStream(facingMode, quality, micEnabled);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      await requestWakeLock();

      const preset = QUALITY_MAP[quality];
      const pc = setupPeerConnection(stream, preset);
      setStreaming(true);

      const ws = new WebSocket(getSignalWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        const vTrack = stream.getVideoTracks()[0];
        const settings = vTrack?.getSettings();
        ws.send(
          JSON.stringify({
            type: "join",
            roomId: cleanRoom,
            role: "mobile",
            meta: {
              deviceLabel: vTrack?.label || "Cámara Móvil",
              width: settings?.width,
              height: settings?.height,
              fps: settings?.frameRate
                ? Math.round(settings.frameRate)
                : undefined,
              facingMode,
              mirrored: facingMode === "user" && mirrorPreview,
            },
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
          const hasHost = Boolean(data.hasHost);
          setHostConnected(hasHost);
          if (hasHost && pc.signalingState === "stable" && !pc.localDescription) {
            await createAndSendOffer();
          }
          return;
        }

        if (data.type === "peer-joined" && data.role === "host") {
          setHostConnected(true);
          await createAndSendOffer();
          return;
        }

        if (data.type === "peer-left" && data.role === "host") {
          setHostConnected(false);
          setPhase("waiting");
          return;
        }

        if (data.type === "answer" && data.sdp) {
          await pc.setRemoteDescription(
            new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit)
          );
          for (const cand of pendingCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
          pendingCandidatesRef.current = [];
          return;
        }

        if (data.type === "ice-candidate" && data.candidate) {
          const cand = data.candidate as RTCIceCandidateInit;
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } else {
            pendingCandidatesRef.current.push(cand);
          }
          return;
        }

        if (data.type === "host-command") {
          if (data.command === "flip-camera") {
            const next = facingMode === "user" ? "environment" : "user";
            await switchCameraTrack(next, quality, micEnabled);
          } else if (
            data.command === "set-quality" &&
            typeof data.value === "string" &&
            data.value in QUALITY_MAP
          ) {
            await switchCameraTrack(
              facingMode,
              data.value as QualityPreset,
              micEnabled
            );
          }
        }
      };

      ws.onerror = () => {
        setErrorMsg("Error de conexión con el servidor de señalización.");
        setPhase("error");
      };

      ws.onclose = () => {
        setHostConnected(false);
      };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "No se pudo acceder a la cámara del dispositivo.";
      setErrorMsg(
        msg.includes("Permission") || msg.includes("NotAllowed")
          ? "Permiso de cámara denegado. Habilita el acceso a la cámara en el navegador."
          : msg
      );
      stopAll();
    }
  }, [
    acquireCameraStream,
    createAndSendOffer,
    facingMode,
    micEnabled,
    mirrorPreview,
    quality,
    requestWakeLock,
    roomInput,
    setupPeerConnection,
    stopAll,
    switchCameraTrack,
  ]);

  // Poll real outbound WebRTC stats every 1s
  useEffect(() => {
    if (!streaming) return;
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
          if (stat.type === "outbound-rtp" && stat.kind === "video") {
            if (typeof stat.framesPerSecond === "number") {
              fps = Math.round(stat.framesPerSecond);
            }
            if (stat.frameWidth && stat.frameHeight) {
              resolution = `${stat.frameWidth}×${stat.frameHeight}`;
            }
            if (typeof stat.bytesSent === "number") {
              const now = stat.timestamp || performance.now();
              if (prevBytesRef.current) {
                const dtSec = (now - prevBytesRef.current.ts) / 1000;
                if (dtSec > 0) {
                  kbps = Math.round(
                    ((stat.bytesSent - prevBytesRef.current.bytes) * 8) /
                      1000 /
                      dtSec
                  );
                }
              }
              prevBytesRef.current = { bytes: stat.bytesSent, ts: now };
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

        setStats({ fps, kbps, rttMs, resolution });
      } catch {
        // Ignore stats failures
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [streaming]);

  const toggleTorch = async () => {
    const vTrack = streamRef.current?.getVideoTracks()[0];
    if (!vTrack || !torchSupported) return;
    const next = !torchOn;
    try {
      await vTrack.applyConstraints({
        // @ts-expect-error torch constraint supported on mobile Chrome/Android
        advanced: [{ torch: next }],
      });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  };

  const phaseLabel =
    phase === "connected"
      ? "Transmitiendo al PC"
      : phase === "signaling"
      ? "Negociando WebRTC..."
      : phase === "waiting"
      ? hostConnected
        ? "PC listo, conectando..."
        : "Esperando al PC..."
      : phase === "error"
      ? "Error de enlace"
      : "Listo para transmitir";

  return (
    <div className="min-h-dvh bg-[#090C10] text-slate-100 flex flex-col justify-between select-none">
      {/* Compact Sticky Top Bar (<= 52px) */}
      <header className="sticky top-0 z-30 h-13 px-4 flex items-center justify-between bg-[#090C10]/90 backdrop-blur-md border-b border-white/10">
        <button
          type="button"
          onClick={() => {
            stopAll();
            onExitMobile();
          }}
          className="min-h-[44px] min-w-[44px] -ml-2 px-2 flex items-center gap-1.5 text-sm font-medium text-slate-300 hover:text-white active:opacity-75"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="whitespace-nowrap">Modo PC</span>
        </button>

        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="text-slate-400">Sala</span>
          <span className="font-mono tabular-nums text-white tracking-wider">
            {roomInput || "------"}
          </span>
        </div>

        <div className="text-xs font-medium whitespace-nowrap">
          <span
            className={
              phase === "connected"
                ? "text-emerald-400"
                : phase === "error"
                ? "text-rose-400"
                : "text-slate-300"
            }
          >
            {phase === "connected"
              ? "En Vivo"
              : hostConnected
              ? "PC Listo"
              : "Sin enlace"}
          </span>
        </div>
      </header>

      {/* Main Viewfinder Area */}
      <main className="flex-1 flex flex-col px-4 py-3 gap-3 max-w-2xl w-full mx-auto">
        {!streaming && (
          <div className="rounded-2xl bg-[#11161F] border border-white/10 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h1 className="text-base font-semibold text-white">
                Cámara Móvil PANDAFACE
              </h1>
              <span className="text-xs text-slate-400">WebRTC P2P</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="mobile-room-code"
                  className="block text-xs text-slate-400 mb-1.5"
                >
                  Código de Sala del PC
                </label>
                <input
                  id="mobile-room-code"
                  type="text"
                  maxLength={12}
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                  placeholder="Ej. A7K9P2"
                  className="w-full h-12 px-3.5 rounded-xl bg-[#090C10] border border-white/15 font-mono text-base tracking-widest text-white uppercase focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Perfil de Captura
                </label>
                <div className="grid grid-cols-3 gap-1.5 bg-[#090C10] p-1 rounded-xl border border-white/10">
                  {(Object.keys(QUALITY_MAP) as QualityPreset[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setQuality(key)}
                      className={`h-10 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                        quality === key
                          ? "bg-blue-600 text-white"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      {key === "720p30"
                        ? "720p 30"
                        : key === "720p24"
                        ? "720p 24"
                        : "480p 30"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Camera Viewfinder */}
        <div className="relative flex-1 min-h-[300px] rounded-2xl overflow-hidden bg-[#0E131B] border border-white/10 flex items-center justify-center">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${
              mirrorPreview && facingMode === "user" ? "-scale-x-100" : ""
            } ${streaming ? "opacity-100" : "opacity-0"}`}
          />

          {!streaming && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-[#161D29] border border-white/10 flex items-center justify-center text-slate-300">
                <Camera className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-white">
                  Cámara inactiva
                </p>
              </div>
            </div>
          )}

          {/* Measured Telemetry Scrim */}
          <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
            <div className="px-2.5 py-1.5 rounded-lg bg-black/65 backdrop-blur-sm text-xs text-slate-200 font-medium">
              {phaseLabel}
            </div>
            {streaming && (
              <div className="px-2.5 py-1.5 rounded-lg bg-black/65 backdrop-blur-sm font-mono tabular-nums text-[11px] text-slate-200 flex items-center gap-2">
                <span>{stats.resolution || QUALITY_MAP[quality].label}</span>
                <span aria-hidden="true">·</span>
                <span>{stats.fps !== null ? `${stats.fps} fps` : "— fps"}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {stats.rttMs !== null ? `${stats.rttMs} ms` : "— ms"}
                </span>
              </div>
            )}
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl bg-rose-950/60 border border-rose-500/40 px-3.5 py-2.5 text-xs text-rose-200"
          >
            {errorMsg}
          </div>
        )}
      </main>

      {/* Bottom Thumb-Zone Controls */}
      <footer className="sticky bottom-0 z-30 bg-[#0D1117]/95 backdrop-blur-md border-t border-white/10 px-4 py-3 space-y-2.5 max-w-2xl w-full mx-auto">
        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => {
              const next = facingMode === "user" ? "environment" : "user";
              if (streaming) {
                void switchCameraTrack(next, quality, micEnabled);
              } else {
                setFacingMode(next);
                setMirrorPreview(next === "user");
              }
            }}
            className="min-h-[48px] rounded-xl bg-[#161C26] border border-white/10 flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-slate-200 active:scale-[0.98]"
          >
            <RefreshCw className="w-4 h-4" />
            <span>{facingMode === "user" ? "Frontal" : "Trasera"}</span>
          </button>

          <button
            type="button"
            onClick={() => setMirrorPreview((v) => !v)}
            className={`min-h-[48px] rounded-xl border flex flex-col items-center justify-center gap-1 text-[11px] font-medium active:scale-[0.98] ${
              mirrorPreview
                ? "bg-blue-600/20 border-blue-500/50 text-blue-200"
                : "bg-[#161C26] border-white/10 text-slate-300"
            }`}
          >
            <FlipHorizontal2 className="w-4 h-4" />
            <span>Espejo</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const next = !micEnabled;
              if (streaming) {
                void switchCameraTrack(facingMode, quality, next);
              } else {
                setMicEnabled(next);
              }
            }}
            className={`min-h-[48px] rounded-xl border flex flex-col items-center justify-center gap-1 text-[11px] font-medium active:scale-[0.98] ${
              micEnabled
                ? "bg-blue-600/20 border-blue-500/50 text-blue-200"
                : "bg-[#161C26] border-white/10 text-slate-300"
            }`}
          >
            {micEnabled ? (
              <Mic className="w-4 h-4" />
            ) : (
              <MicOff className="w-4 h-4" />
            )}
            <span>{micEnabled ? "Audio On" : "Sin Audio"}</span>
          </button>

          <button
            type="button"
            disabled={!torchSupported && streaming}
            onClick={() => {
              if (streaming && torchSupported) {
                void toggleTorch();
              } else {
                const nextQuality: QualityPreset =
                  quality === "720p30"
                    ? "480p30"
                    : quality === "480p30"
                    ? "720p24"
                    : "720p30";
                if (streaming) {
                  void switchCameraTrack(facingMode, nextQuality, micEnabled);
                } else {
                  setQuality(nextQuality);
                }
              }
            }}
            className={`min-h-[48px] rounded-xl border flex flex-col items-center justify-center gap-1 text-[11px] font-medium active:scale-[0.98] disabled:opacity-40 ${
              torchOn
                ? "bg-amber-500/20 border-amber-400/50 text-amber-200"
                : "bg-[#161C26] border-white/10 text-slate-300"
            }`}
          >
            {streaming && torchSupported ? (
              torchOn ? (
                <Zap className="w-4 h-4" />
              ) : (
                <ZapOff className="w-4 h-4" />
              )
            ) : (
              <Radio className="w-4 h-4" />
            )}
            <span>
              {streaming && torchSupported
                ? torchOn
                  ? "Luz On"
                  : "Linterna"
                : quality === "720p30"
                ? "720p"
                : quality === "480p30"
                ? "480p"
                : "24fps"}
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (streaming) {
              stopAll();
            } else {
              void startStreaming();
            }
          }}
          className={`w-full h-13 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors active:scale-[0.99] ${
            streaming
              ? "bg-rose-600 hover:bg-rose-500 text-white"
              : "bg-blue-600 hover:bg-blue-500 text-white"
          }`}
        >
          {streaming ? (
            <>
              <Square className="w-4 h-4 fill-current" />
              <span>Detener Transmisión</span>
            </>
          ) : (
            <>
              <Camera className="w-4 h-4" />
              <span>Iniciar Cámara y Transmitir al PC</span>
            </>
          )}
        </button>
      </footer>
    </div>
  );
};
