import React, { useState } from "react";
import { AppWindow } from "lucide-react";
import { usePWAInstall } from "../hooks/usePWAInstall";

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        title="Instalar PANDAFACE como ventana independiente (PWA) para SplitCam y WhatsApp"
        className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 border border-emerald-400/40 text-xs font-semibold text-white flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
      >
        <AppWindow className="w-3.5 h-3.5" />
        <span>Instalar PWA</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="px-3 py-2 rounded-lg bg-[#161D29] hover:bg-[#1E2736] border border-white/10 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
        >
          <AppWindow className="w-3.5 h-3.5 text-emerald-400" />
          <span>Instalar en iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-xl bg-[#11161F] border border-white/15 p-6 shadow-2xl">
              <h3 className="text-base font-semibold text-white">
                Instalar en iPhone / iPad
              </h3>
              <p className="mt-2 text-xs text-slate-300 leading-relaxed">
                1. Pulsa el botón <strong>Compartir</strong> en la barra de
                Safari.
                <br />
                2. Desplázate y elige{" "}
                <strong>Añadir a pantalla de inicio</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-xs font-semibold text-white transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
