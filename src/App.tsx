import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { MobileTransmitter } from "./components/MobileTransmitter";
import { PcStudio } from "./components/PcStudio";
import { generateRoomCode } from "./lib/webrtcConfig";
import type { KeySlotInfo } from "./types/studio";

export default function App() {
  const [isMobileMode, setIsMobileMode] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "mobile";
  });

  const [mobileRoomFromUrl] = useState<string>(() => {
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
  const [keySlots, setKeySlots] = useState<KeySlotInfo[]>([
    { id: "slot_1", label: "Cuenta 1", configured: false },
    { id: "slot_2", label: "Cuenta 2", configured: false },
    { id: "slot_3", label: "Cuenta 3", configured: false },
  ]);

  const refreshHealth = () => {
    fetch("/api/health")
      .then((res) => res.json())
      .then(
        (data: { decartConfigured?: boolean; keySlots?: KeySlotInfo[] }) => {
          setDecartConfigured(Boolean(data.decartConfigured));
          if (Array.isArray(data.keySlots) && data.keySlots.length > 0) {
            setKeySlots(data.keySlots);
          }
        }
      )
      .catch(() => {
        setDecartConfigured(null);
      });
  };

  useEffect(() => {
    refreshHealth();
  }, []);

  const handleRegenerateRoom = () => {
    const next = generateRoomCode();
    sessionStorage.setItem("pandaface_room_id", next);
    setHostRoomId(next);
  };

  if (isMobileMode) {
    return (
      <MobileTransmitter
        initialRoomId={mobileRoomFromUrl || hostRoomId}
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

            <div className="shrink-0">
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
        />
      </main>
    </div>
  );
}
