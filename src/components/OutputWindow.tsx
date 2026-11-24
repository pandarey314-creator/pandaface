import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  EyeOff,
  FlipHorizontal2,
  Maximize2,
  Minimize2,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  RTC_CONFIG,
  getSignalWsUrl,
  prioritizeLowLatencyCodecs,
} from "../lib/webrtcConfig";

interface OutputWindowProps {
  roomId?: string;
}

export const OutputWindow: React.FC<OutputWindowProps> = ({ roomId }) => {
  const [resolvedRoomId, setResolvedRoomId] = useState<string>(() => {
    const cleanProp = (roomId || "").toUpperCase().trim();
    if (/^[A-Z0-9]{4,12}$/.test(cleanProp)) return cleanProp;
    try {
      const stored = (localStorage.getItem("pandaface_active_room") || "")
        .toUpperCase()
        .trim();
      if (/^[A-Z0-9]{4,12}$/.test(stored)) return stored;
    } catch {
      // Ignore storage access failure
    }
    return "";
  });

  const [isSplitCamPreset] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("splitcam") === "1";
  });

  const [connected, setConnected] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [hostOnline, setHostOnline] = useState(false);
  const [fitMode, setFitMode] = useState<"contain" | "cover">(
    isSplitCamPreset ? "cover" : "contain"
  );
  const [mirrored, setMirrored] = useState(false);
  const [muted, setMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(!isSplitCamPreset);
  const [cleanLock, setCleanLock] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const hudTimerRef = useRef<number | null>(null);
  const cleanLockRef = useRef<boolean>(false);
  cleanLockRef.current = cleanLock;

  const wakeHud = useCallback(() => {
    if (cleanLockRef.current) return;
    setHudVisible(true);
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current);
    }
    hudTimerRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, 1800);
  }, []);

  // Auto-discover active Studio room if launched directly from PWA shortcut without ?room=
  useEffect(() => {
    const propClean = (roomId || "").toUpperCase().trim();
    if (/^[A-Z0-9]{4,12}$/.test(propClean)) {
      setResolvedRoomId(propClean);
      return;
    }

    let cancelled = false;
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("pandaface-studio-sync");
      bc.onmessage = (ev: MessageEvent<{ type?: string; roomId?: string }>) => {
        const nextRoom = String(ev.data?.roomId || "")
          .toUpperCase()
          .trim();
        if (ev.data?.type === "room-announce" && /^[A-Z0-9]{4,12}$/.test(nextRoom)) {
          setResolvedRoomId((prev) => prev || nextRoom);
        }
      };
      bc.postMessage({ type: "request-room" });
    } catch {
      // BroadcastChannel optional
    }

    const pollActiveRoom = async () => {
      try {
        const res = await fetch("/api/rooms/active", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { roomId?: string | null };
        const srvRoom = String(data.roomId || "")
          .toUpperCase()
          .trim();
        if (!cancelled && /^[A-Z0-9]{4,12}$/.test(srvRoom)) {
          setResolvedRoomId((prev) => prev || srvRoom);
        }
      } catch {
        // Ignore transient network errors
      }
    };

    void pollActiveRoom();
    const timer = window.setInterval(() => {
      if (!resolvedRoomId) {
        void pollActiveRoom();
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      bc?.close();
    };
  }, [resolvedRoomId, roomId]);

  // Distinct OS Window Title for SplitCam / OBS Window Capture
  useEffect(() => {
    document.title = "PANDAFACE Salida Camara";
    if (!isSplitCamPreset) {
      wakeHud();
    }
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cleanLockRef.current) {
        setCleanLock(false);
        setHudVisible(true);
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      window.removeEventListener("keydown", onKeyDown);
      if (hudTimerRef.current !== null) {
        window.clearTimeout(hudTimerRef.current);
      }
    };
  }, [isSplitCamPreset, wakeHud]);

  // Keep Screen Awake while streaming so SplitCam never captures a frozen/throttled window
  useEffect(() => {
    if (!hasStream) return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    if (nav.wakeLock?.request) {
      void nav.wakeLock
        .request("screen")
        .then((wl) => {
          lock = wl;
        })
        .catch(() => undefined);
    }
    return () => {
      if (lock) {
        void lock.release().catch(() => undefined);
      }
    };
  }, [hasStream]);

  useEffect(() => {
    if (!resolvedRoomId) return;

    let closedByEffect = false;
    let reconnectTimer: number | null = null;

    const cleanupPc = () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      pendingIceRef.current = [];
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setHasStream(false);
      setConnected(false);
    };

    const connectWs = () => {
      if (closedByEffect) return;
      const ws = new WebSocket(getSignalWsUrl());
      wsRef.current = ws;

      const createViewerPc = () => {
        if (pcRef.current) pcRef.current.close();
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;

        pc.ontrack = (event) => {
          try {
            if ("playoutDelayHint" in event.receiver) {
              (
                event.receiver as RTCRtpReceiver & {
                  playoutDelayHint?: number;
                }
              ).playoutDelayHint = 0;
            }
          } catch {
            // Ignore playoutDelayHint error
          }
          const remoteStream =
            event.streams[0] || new MediaStream([event.track]);
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
            void videoRef.current.play().catch(() => undefined);
          }
          setHasStream(true);
          setConnected(true);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "output-ice-candidate",
                candidate: event.candidate.toJSON(),
              })
            );
          }
        };

        pc.onconnectionstatechange = () => {
          if (
            pc.connectionState === "disconnected" ||
            pc.connectionState === "failed" ||
            pc.connectionState === "closed"
          ) {
            setConnected(false);
            setHasStream(false);
          }
        };

        return pc;
      };

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "join",
            roomId: resolvedRoomId,
            role: "output-viewer",
            meta: { deviceLabel: "PANDAFACE Salida Camara" },
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
          setHostOnline(Boolean(data.hasHost));
          return;
        }

        if (data.type === "peer-left" && data.role === "host") {
          setHostOnline(false);
          cleanupPc();
          return;
        }

        if (data.type === "output-status" && data.hasOutput === false) {
          cleanupPc();
          return;
        }

        if (data.type === "output-offer" && data.sdp) {
          try {
            const pc = createViewerPc();
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit)
            );
            for (const cand of pendingIceRef.current) {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            }
            pendingIceRef.current = [];
            const answer = await pc.createAnswer();
            const tunedSdp = prioritizeLowLatencyCodecs(answer.sdp || "");
            await pc.setLocalDescription({
              type: answer.type,
              sdp: tunedSdp,
            });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "output-answer",
                  sdp: pc.localDescription,
                })
              );
            }
          } catch {
            cleanupPc();
          }
          return;
        }

        if (data.type === "output-ice-candidate" && data.candidate) {
          const cand = data.candidate as RTCIceCandidateInit;
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } else {
            pendingIceRef.current.push(cand);
          }
        }
      };

      ws.onclose = () => {
        cleanupPc();
        if (!closedByEffect) {
          reconnectTimer = window.setTimeout(connectWs, 1500);
        }
      };
    };

    connectWs();

    return () => {
      closedByEffect = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
      cleanupPc();
    };
  }, [resolvedRoomId]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (stageRef.current) {
        await stageRef.current.requestFullscreen();
      }
    } catch {
      // Ignore fullscreen denial
    }
  };

  return (
    <div
      ref={stageRef}
      onMouseMove={wakeHud}
      onMouseEnter={wakeHud}
      onDoubleClick={() => {
        setCleanLock((prev) => {
          const next = !prev;
          setHudVisible(!next);
          return next;
        });
      }}
      className={`fixed inset-0 w-screen h-screen bg-black flex items-center justify-center overflow-hidden select-none ${
        hudVisible && !cleanLock ? "cursor-default" : "cursor-none"
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        disablePictureInPicture
        className={`w-full h-full ${
          fitMode === "cover" ? "object-cover" : "object-contain"
        } ${mirrored ? "-scale-x-100" : ""}`}
      />

      {!hasStream && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6 pointer-events-none">
          <Sparkles className="w-9 h-9 text-slate-600" />
          <p className="text-sm font-medium text-slate-200">
            {!resolvedRoomId
              ? "Buscando estudio PANDAFACE activo en este PC..."
              : !hostOnline
              ? `Esperando conexión del estudio (Sala ${resolvedRoomId})...`
              : connected
              ? "Sincronizando video de salida..."
              : "Esperando transmisión PANDAFACE — Lista para capturar en SplitCam"}
          </p>
        </div>
      )}

      <div
        className={`fixed top-4 right-4 z-40 flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-black/85 backdrop-blur-md border border-white/15 transition-opacity duration-200 ${
          hudVisible && !cleanLock
            ? "opacity-100"
            : "opacity-0 pointer-events-none"
        }`}
      >
        <button
          type="button"
          onClick={() =>
            setFitMode((m) => (m === "contain" ? "cover" : "contain"))
          }
          className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white whitespace-nowrap"
        >
          {fitMode === "contain" ? "Llenar 16:9" : "Ajustar"}
        </button>

        <button
          type="button"
          onClick={() => setMirrored((v) => !v)}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
            mirrored
              ? "bg-blue-600 text-white"
              : "bg-white/10 hover:bg-white/20 text-white"
          }`}
        >
          <FlipHorizontal2 className="w-3.5 h-3.5" />
          <span>Espejo</span>
        </button>

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
        >
          {muted ? (
            <VolumeX className="w-3.5 h-3.5" />
          ) : (
            <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
          )}
          <span>{muted ? "Audio Off" : "Audio On"}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setCleanLock(true);
            setHudVisible(false);
          }}
          title="Ocultar controles permanentemente para SplitCam (doble clic o Esc para mostrar)"
          className="px-2.5 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap"
        >
          <EyeOff className="w-3.5 h-3.5" />
          <span>Modo SplitCam</span>
        </button>

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
        >
          {isFullscreen ? (
            <>
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Salir</span>
            </>
          ) : (
            <>
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Fullscreen</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
