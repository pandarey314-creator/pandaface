import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Download,
  Loader2,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { AdminApiModal } from "./components/AdminApiModal";
import { MobileTransmitter } from "./components/MobileTransmitter";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { OutputWindow } from "./components/OutputWindow";
import { PWAInstallButton } from "./components/PWAInstallButton";
import { PcStudio } from "./components/PcStudio";
import { generateRoomCode } from "./lib/webrtcConfig";
import type { ApiUserProfile, KeySlotInfo } from "./types/studio";

export default function App() {
  const [isOutputWindowMode] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "output";
  });

  const [isMobileMode, setIsMobileMode] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "mobile";
  });

  const [roomFromUrl] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get("room") || "").toUpperCase();
  });

  const [hostRoomId, setHostRoomId] = useState<string>(() => {
    const saved = sessionStorage.getItem("pandaface_room_id");
    if (saved && /^[A-Z0-9]{4,12}$/.test(saved)) return saved;
    const fresh = generateRoomCode();
    sessionStorage.setItem("pandaface_room_id", fresh);
    return fresh;
  });

  const [broadcastMode, setBroadcastMode] = useState<boolean>(false);
  const [decartConfigured, setDecartConfigured] = useState<boolean | null>(
    null
  );
  const [installState, setInstallState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [installProgress, setInstallProgress] = useState<number>(0);
  const [keySlots, setKeySlots] = useState<KeySlotInfo[]>([
    { id: "slot_1", label: "Cuenta 1", configured: false },
    { id: "slot_2", label: "Cuenta 2", configured: false },
    { id: "slot_3", label: "Cuenta 3", configured: false },
  ]);

  const [adminOpen, setAdminOpen] = useState<boolean>(false);
  const [apiUsers, setApiUsers] = useState<ApiUserProfile[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [adminProtected, setAdminProtected] = useState<boolean>(false);
  const [adminLocked, setAdminLocked] = useState<boolean>(false);
  const [adminPin, setAdminPin] = useState<string>("");
  const [appliedRevision, setAppliedRevision] = useState<number>(0);

  const refreshAdminUsers = useCallback(
    async (pinOverride?: string) => {
      const effectivePin = pinOverride !== undefined ? pinOverride : adminPin;
      try {
        const res = await fetch("/api/admin/users", {
          headers: effectivePin ? { "x-admin-pin": effectivePin } : {},
          cache: "no-store",
        });
        const data = (await res.json()) as {
          ok?: boolean;
          adminProtected?: boolean;
          users?: ApiUserProfile[];
          activeUserId?: string;
        };
        setAdminProtected(Boolean(data.adminProtected));
        if (res.status === 401 || res.status === 403 || !res.ok || !data.ok) {
          setAdminLocked(Boolean(data.adminProtected));
          return;
        }
        setAdminLocked(false);
        if (Array.isArray(data.users)) {
          setApiUsers(data.users);
        }
        if (typeof data.activeUserId === "string") {
          setActiveUserId(data.activeUserId);
        }
      } catch {
        // Ignore transient network errors
      }
    },
    [adminPin]
  );

  const handleUnlockAdminPin = useCallback(
    async (pin: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/admin/verify-pin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        const data = (await res.json()) as { ok?: boolean };
        if (!res.ok || !data.ok) {
          return false;
        }
        setAdminPin(pin);
        setAdminLocked(false);
        await refreshAdminUsers(pin);
        return true;
      } catch {
        return false;
      }
    },
    [refreshAdminUsers]
  );

  const refreshHealth = useCallback(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then(
        (data: {
          decartConfigured?: boolean;
          keySlots?: KeySlotInfo[];
          activeUserId?: string | null;
          adminProtected?: boolean;
        }) => {
          setDecartConfigured(Boolean(data.decartConfigured));
          if (Array.isArray(data.keySlots) && data.keySlots.length > 0) {
            setKeySlots(data.keySlots);
          }
          if (typeof data.activeUserId === "string") {
            setActiveUserId((prev) => prev || data.activeUserId || null);
          }
          if (typeof data.adminProtected === "boolean") {
            setAdminProtected(data.adminProtected);
          }
        }
      )
      .catch(() => {
        setDecartConfigured(null);
      });
  }, []);

  useEffect(() => {
    if (isOutputWindowMode || isMobileMode) return;
    refreshHealth();
    void refreshAdminUsers();
  }, [isMobileMode, isOutputWindowMode, refreshAdminUsers, refreshHealth]);

  useEffect(() => {
    if (isOutputWindowMode || isMobileMode) return;
    try {
      localStorage.setItem("pandaface_active_room", hostRoomId);
    } catch {
      // Ignore storage error
    }
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("pandaface-studio-sync");
      bc.postMessage({ type: "room-announce", roomId: hostRoomId });
      bc.onmessage = (ev: MessageEvent<{ type?: string }>) => {
        if (ev.data?.type === "request-room") {
          bc?.postMessage({ type: "room-announce", roomId: hostRoomId });
        }
      };
    } catch {
      // BroadcastChannel optional
    }
    return () => {
      bc?.close();
    };
  }, [hostRoomId, isMobileMode, isOutputWindowMode]);

  const activeApiUser = useMemo(
    () => apiUsers.find((u) => u.id === activeUserId) || null,
    [activeUserId, apiUsers]
  );

  const handleRegenerateRoom = () => {
    const next = generateRoomCode();
    sessionStorage.setItem("pandaface_room_id", next);
    setHostRoomId(next);
  };

  const handleInstallLocalPc = async () => {
    if (installState === "downloading") return;
    setInstallState("downloading");
    setInstallProgress(0);
    try {
      const infoRes = await fetch("/api/pc-package/info?format=exe", {
        cache: "no-store",
      });
      if (!infoRes.ok) {
        throw new Error("No se pudo preparar PANDAFACE.exe");
      }
      const info = (await infoRes.json()) as {
        ok?: boolean;
        filename?: string;
        size?: number;
        chunkSize?: number;
      };
      const totalSize = Number(info.size || 0);
      const chunkSize = Math.min(
        Math.max(Number(info.chunkSize || 8 * 1024 * 1024), 1024 * 1024),
        12 * 1024 * 1024
      );
      const downloadName = info.filename || "PANDAFACE.exe";

      if (!totalSize || totalSize <= 0) {
        const directRes = await fetch("/api/pc-package/download?format=exe", {
          cache: "no-store",
        });
        if (!directRes.ok) throw new Error("Falló la descarga directa");
        const blob = await directRes.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      } else {
        const chunks: Blob[] = [];
        let downloaded = 0;

        while (downloaded < totalSize) {
          const end = Math.min(downloaded + chunkSize - 1, totalSize - 1);
          const partRes = await fetch("/api/pc-package/download?format=exe", {
            cache: "no-store",
            headers: {
              Range: `bytes=${downloaded}-${end}`,
            },
          });
          if (!partRes.ok && partRes.status !== 206) {
            throw new Error(`Error descargando fragmento (${partRes.status})`);
          }
          const partBlob = await partRes.blob();
          if (partBlob.size === 0) {
            throw new Error("Fragmento vacío recibido");
          }
          chunks.push(partBlob);
          downloaded += partBlob.size;
          setInstallProgress(Math.min(100, Math.round((downloaded / totalSize) * 100)));
          if (partRes.status === 200) {
            break;
          }
        }

        const fullBlob = new Blob(chunks, {
          type: "application/vnd.microsoft.portable-executable",
        });
        const url = URL.createObjectURL(fullBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      }

      setInstallProgress(100);
      setInstallState("done");
      window.setTimeout(() => {
        setInstallState("idle");
        setInstallProgress(0);
      }, 3000);
    } catch {
      setInstallState("error");
      setInstallProgress(0);
      window.setTimeout(() => setInstallState("idle"), 2800);
    }
  };

  if (isOutputWindowMode) {
    return (
      <>
        <OutputWindow roomId={roomFromUrl} />
        <OfflineIndicator />
      </>
    );
  }

  if (isMobileMode) {
    return (
      <MobileTransmitter
        initialRoomId={roomFromUrl || hostRoomId}
        onExitMobile={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete("mode");
          url.searchParams.delete("room");
          window.history.replaceState({}, "", url.toString());
          setIsMobileMode(false);
        }}
      />
    );
  }

  return (
    <div
      className={`min-h-screen bg-[#090C10] text-slate-100 flex flex-col ${
        broadcastMode ? "h-screen overflow-hidden" : ""
      }`}
    >
      {/* Clean Header Bar (hidden in Broadcast Capture Mode) */}
      {!broadcastMode && (
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#090C10]/90 backdrop-blur-md">
          <div className="max-w-[1440px] mx-auto px-4 lg:px-6 h-14 flex items-center justify-between gap-8">
            <span className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
              PANDAFACE
            </span>

            <div className="flex items-center gap-2 shrink-0">
              <PWAInstallButton />

              <button
                type="button"
                onClick={() => setAdminOpen(true)}
                className="px-3.5 py-2 rounded-lg bg-[#161D29] hover:bg-[#1E2736] border border-white/10 text-xs font-medium text-white flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  {activeApiUser
                    ? `Admin API · ${activeApiUser.name}`
                    : "Admin API"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleInstallLocalPc()}
                disabled={installState === "downloading"}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors border ${
                  installState === "done"
                    ? "bg-emerald-950/60 border-emerald-500/40 text-emerald-300"
                    : installState === "error"
                    ? "bg-rose-950/60 border-rose-500/40 text-rose-300"
                    : "bg-blue-600 hover:bg-blue-500 border-blue-500/60 text-white"
                } disabled:opacity-70`}
              >
                {installState === "downloading" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="font-mono tabular-nums">
                      {installProgress > 0
                        ? `Descargando ${installProgress}%`
                        : "Preparando .exe..."}
                    </span>
                  </>
                ) : installState === "done" ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Descargado (.exe)</span>
                  </>
                ) : installState === "error" ? (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    <span>Reintentar</span>
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    <span>Instalar PC (.exe)</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setIsMobileMode(true)}
                className="px-3.5 py-2 rounded-lg bg-[#161D29] hover:bg-[#1E2736] border border-white/10 text-xs font-medium text-white flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
              >
                <Smartphone className="w-3.5 h-3.5 text-blue-400" />
                <span>Vista Móvil</span>
              </button>
            </div>
          </div>
        </header>
      )}

      <main className="flex-1">
        <PcStudio
          roomId={hostRoomId}
          onRegenerateRoom={handleRegenerateRoom}
          decartConfigured={decartConfigured}
          keySlots={keySlots}
          onRefreshHealth={refreshHealth}
          broadcastMode={broadcastMode}
          onBroadcastModeChange={setBroadcastMode}
          activeApiUser={activeApiUser}
          appliedRevision={appliedRevision}
          onOpenAdmin={() => setAdminOpen(true)}
        />
      </main>

      <AdminApiModal
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        users={apiUsers}
        activeUserId={activeUserId}
        keySlots={keySlots}
        adminProtected={adminProtected}
        locked={adminLocked}
        adminPin={adminPin}
        onUnlockWithPin={handleUnlockAdminPin}
        onRefreshAdmin={async () => {
          refreshHealth();
          await refreshAdminUsers();
        }}
        onUsersUpdated={(nextUsers, nextActiveId) => {
          setApiUsers(nextUsers);
          setActiveUserId(nextActiveId);
        }}
        onApplyUserToStudio={(user) => {
          setActiveUserId(user.id);
          setApiUsers((prev) =>
            prev.some((u) => u.id === user.id)
              ? prev.map((u) => (u.id === user.id ? user : u))
              : [...prev, user]
          );
          setAppliedRevision((r) => r + 1);
        }}
      />
      <OfflineIndicator />
    </div>
  );
}

