import React, { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import {
  DEFAULT_DECART_API_CONFIG,
  FACE_PRESETS,
  LUCY_MODELS,
  type ApiUserProfile,
  type ApiUserRole,
  type DecartCodec,
  type DecartMirrorMode,
  type DecartResolution,
  type KeySlotInfo,
  type LucyModelId,
} from "../types/studio";

interface AdminApiModalProps {
  open: boolean;
  onClose: () => void;
  users: ApiUserProfile[];
  activeUserId: string | null;
  keySlots: KeySlotInfo[];
  adminProtected: boolean;
  locked: boolean;
  adminPin: string;
  onUnlockWithPin: (pin: string) => Promise<boolean>;
  onRefreshAdmin: () => Promise<void>;
  onUsersUpdated: (users: ApiUserProfile[], activeUserId: string | null) => void;
  onApplyUserToStudio: (user: ApiUserProfile) => void;
}

function buildEmptyDraft(keySlots: KeySlotInfo[]): ApiUserProfile {
  const firstConfigured = keySlots.find((s) => s.configured)?.id || "slot_1";
  const now = Date.now();
  return {
    id: "",
    name: "",
    handle: "",
    role: "operator",
    enabled: true,
    assignedSlotId: firstConfigured,
    allowedModels: LUCY_MODELS.map((m) => m.id),
    permissions: {
      canUseMobileP2p: true,
      canUseUsb: true,
      canUseWindowCapture: true,
      canRecord: true,
      canEditEngineSettings: true,
    },
    apiSettings: {
      ...DEFAULT_DECART_API_CONFIG,
      model: "lucy-2.5",
      fastMode: true,
      enhancePrompt: true,
      defaultPrompt: FACE_PRESETS[0].recommendedPrompt,
    },
    createdAt: now,
    updatedAt: now,
    lastAppliedAt: null,
  };
}

export const AdminApiModal: React.FC<AdminApiModalProps> = ({
  open,
  onClose,
  users,
  activeUserId,
  keySlots,
  adminProtected,
  locked,
  adminPin,
  onUnlockWithPin,
  onRefreshAdmin,
  onUsersUpdated,
  onApplyUserToStudio,
}) => {
  const [selectedId, setSelectedId] = useState<string>(activeUserId || "");
  const [draft, setDraft] = useState<ApiUserProfile>(() =>
    buildEmptyDraft(keySlots)
  );
  const [isCreatingNew, setIsCreatingNew] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);
  const [pinInput, setPinInput] = useState<string>("");
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFeedback(null);
    if (isCreatingNew) return;
    const match =
      users.find((u) => u.id === selectedId) ||
      users.find((u) => u.id === activeUserId) ||
      users[0];
    if (match) {
      setSelectedId(match.id);
      setDraft(structuredClone(match));
    }
  }, [activeUserId, isCreatingNew, open, selectedId, users]);

  if (!open) return null;

  const authHeaders = (): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(adminPin ? { "x-admin-pin": adminPin } : {}),
  });

  const handleSelectUser = (user: ApiUserProfile) => {
    setIsCreatingNew(false);
    setSelectedId(user.id);
    setDraft(structuredClone(user));
    setFeedback(null);
  };

  const handleStartNewUser = () => {
    setIsCreatingNew(true);
    setSelectedId("");
    setDraft(buildEmptyDraft(keySlots));
    setFeedback(null);
  };

  const handleSaveUser = async (applyAfterSave: boolean) => {
    if (!draft.name.trim()) {
      setFeedback({
        type: "error",
        text: "Ingresa un nombre para el usuario API.",
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const endpoint = isCreatingNew
        ? "/api/admin/users"
        : `/api/admin/users/${encodeURIComponent(draft.id)}`;
      const method = isCreatingNew ? "POST" : "PUT";

      const res = await fetch(endpoint, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(draft),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        user?: ApiUserProfile;
        users?: ApiUserProfile[];
        activeUserId?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.user) {
        setFeedback({
          type: "error",
          text: data.message || "No se pudo guardar el usuario API.",
        });
        return;
      }

      let finalUser = data.user;
      let finalUsers = data.users || users;
      let finalActiveId = data.activeUserId || activeUserId;

      if (applyAfterSave) {
        const applyRes = await fetch(
          `/api/admin/users/${encodeURIComponent(finalUser.id)}/apply`,
          {
            method: "POST",
            headers: authHeaders(),
          }
        );
        const applyData = (await applyRes.json()) as {
          ok?: boolean;
          user?: ApiUserProfile;
          users?: ApiUserProfile[];
          activeUserId?: string;
          message?: string;
        };
        if (!applyRes.ok || !applyData.ok || !applyData.user) {
          onUsersUpdated(finalUsers, finalActiveId);
          setIsCreatingNew(false);
          setSelectedId(finalUser.id);
          setDraft(structuredClone(finalUser));
          setFeedback({
            type: "error",
            text:
              applyData.message ||
              "Usuario guardado, pero no se pudo aplicar al motor.",
          });
          return;
        }
        finalUser = applyData.user;
        finalUsers = applyData.users || finalUsers;
        finalActiveId = applyData.activeUserId || finalUser.id;
        onApplyUserToStudio(finalUser);
      } else if (finalUser.id === finalActiveId) {
        onApplyUserToStudio(finalUser);
      }

      onUsersUpdated(finalUsers, finalActiveId);
      setIsCreatingNew(false);
      setSelectedId(finalUser.id);
      setDraft(structuredClone(finalUser));
      setFeedback({
        type: "ok",
        text: applyAfterSave
          ? `Usuario "${finalUser.name}" guardado y aplicado al motor PANDAFACE.`
          : `Cambios guardados en "${finalUser.name}".`,
      });
    } catch {
      setFeedback({
        type: "error",
        text: "Error de red al guardar la configuración.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleQuickApply = async (user: ApiUserProfile) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(user.id)}/apply`,
        {
          method: "POST",
          headers: authHeaders(),
        }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        user?: ApiUserProfile;
        users?: ApiUserProfile[];
        activeUserId?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.user) {
        setFeedback({
          type: "error",
          text: data.message || "No se pudo aplicar el usuario.",
        });
        return;
      }
      onUsersUpdated(data.users || users, data.activeUserId || data.user.id);
      onApplyUserToStudio(data.user);
      setIsCreatingNew(false);
      setSelectedId(data.user.id);
      setDraft(structuredClone(data.user));
      setFeedback({
        type: "ok",
        text: `Perfil "${data.user.name}" activo en PANDAFACE.`,
      });
    } catch {
      setFeedback({
        type: "error",
        text: "Error al aplicar el usuario.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleQuickToggleEnabled = async (user: ApiUserProfile) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(user.id)}`,
        {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({ ...user, enabled: !user.enabled }),
        }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        user?: ApiUserProfile;
        users?: ApiUserProfile[];
        activeUserId?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.user) {
        setFeedback({
          type: "error",
          text: data.message || "No se pudo actualizar el acceso.",
        });
        return;
      }
      onUsersUpdated(data.users || users, data.activeUserId || activeUserId);
      if (selectedId === data.user.id) {
        setDraft(structuredClone(data.user));
      }
      if (data.user.id === activeUserId) {
        onApplyUserToStudio(data.user);
      }
    } catch {
      setFeedback({ type: "error", text: "Error al cambiar estado." });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteUser = async () => {
    if (isCreatingNew || !draft.id || users.length <= 1) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(draft.id)}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        users?: ApiUserProfile[];
        activeUserId?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.users) {
        setFeedback({
          type: "error",
          text: data.message || "No se pudo eliminar el usuario.",
        });
        return;
      }
      onUsersUpdated(data.users, data.activeUserId || data.users[0]?.id || null);
      const next =
        data.users.find((u) => u.id === data.activeUserId) || data.users[0];
      if (next) {
        setSelectedId(next.id);
        setDraft(structuredClone(next));
        onApplyUserToStudio(next);
      }
      setFeedback({ type: "ok", text: "Usuario eliminado correctamente." });
    } catch {
      setFeedback({ type: "error", text: "Error al eliminar usuario." });
    } finally {
      setBusy(false);
    }
  };

  const handleTestAssignedSlot = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/decart/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keySlot: draft.assignedSlotId,
          ...(draft.apiSettings.customBaseUrl
            ? { baseUrl: draft.apiSettings.customBaseUrl }
            : {}),
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
        setFeedback({
          type: "error",
          text: data.message || "La cuenta asignada no está activa en el servidor.",
        });
        return;
      }
      setFeedback({
        type: "ok",
        text: `${data.label || draft.assignedSlotId} operativa (${
          data.latencyMs ?? 0
        } ms${
          data.concurrentLimit ? ` · Sesiones máx: ${data.concurrentLimit}` : ""
        }).`,
      });
    } catch {
      setFeedback({
        type: "error",
        text: "Error probando la cuenta asignada.",
      });
    } finally {
      setBusy(false);
    }
  };

  const toggleAllowedModel = (modelId: LucyModelId) => {
    setDraft((prev) => {
      const exists = prev.allowedModels.includes(modelId);
      if (exists && prev.allowedModels.length <= 1) {
        return prev;
      }
      const nextAllowed = exists
        ? prev.allowedModels.filter((m) => m !== modelId)
        : [...prev.allowedModels, modelId];
      const nextDefault = nextAllowed.includes(prev.apiSettings.model)
        ? prev.apiSettings.model
        : nextAllowed[0];
      return {
        ...prev,
        allowedModels: nextAllowed,
        apiSettings: {
          ...prev.apiSettings,
          model: nextDefault,
        },
      };
    });
  };

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    const ok = await onUnlockWithPin(pinInput);
    if (!ok) {
      setPinError("PIN incorrecto.");
    } else {
      setPinInput("");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Panel Administrador de Usuarios y API"
    >
      <div className="w-full max-w-6xl max-h-[92vh] rounded-2xl bg-[#0D1219] border border-white/15 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-white/10 bg-[#11161F] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400 shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white truncate">
                Panel Administrador · Usuarios y Control API
              </h2>
              <p className="text-[11px] text-slate-400 truncate">
                Accesos por usuario, asignación de cuentas del servidor y parámetros funcionales completos de la API
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void onRefreshAdmin()}
              className="px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/10 text-xs text-slate-300 hover:text-white flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Actualizar</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg bg-[#090C10] border border-white/10 text-slate-400 hover:text-white"
              aria-label="Cerrar panel administrador"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        {adminProtected && locked ? (
          <div className="p-8 flex flex-col items-center justify-center flex-1">
            <form
              onSubmit={(e) => void submitPin(e)}
              className="w-full max-w-sm rounded-xl bg-[#11161F] border border-white/10 p-5 space-y-4"
            >
              <div className="flex items-center gap-2 text-white font-semibold text-sm">
                <KeyRound className="w-4 h-4 text-blue-400" />
                <span>Acceso protegido por PIN del servidor</span>
              </div>
              <input
                type="password"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="Ingresa ADMIN_ACCESS_PIN"
                className="w-full px-3 py-2 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
              />
              {pinError && (
                <div className="text-xs text-rose-300">{pinError}</div>
              )}
              <button
                type="submit"
                className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white"
              >
                Desbloquear Panel Admin
              </button>
            </form>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] divide-y lg:divide-y-0 lg:divide-x divide-white/10">
            {/* LEFT COLUMN: Server Accounts Summary + Users List */}
            <div className="p-4 space-y-4 bg-[#090C10]/60">
              {/* Server Accounts Status */}
              <div className="rounded-xl bg-[#11161F] border border-white/10 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                    Cuentas en el Servidor (.env)
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    {keySlots.filter((s) => s.configured).length}/{keySlots.length} activas
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {keySlots.map((slot, idx) => (
                    <div
                      key={slot.id}
                      className={`px-2 py-1.5 rounded-lg border text-[11px] ${
                        slot.configured
                          ? "bg-emerald-950/35 border-emerald-500/35 text-emerald-200"
                          : "bg-[#090C10] border-white/10 text-slate-400"
                      }`}
                    >
                      <div className="font-medium truncate">
                        Cuenta {idx + 1}
                      </div>
                      <div className="text-[10px] opacity-85 truncate">
                        {slot.configured ? "Configurada" : slot.envVar || "Vacía"}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Las claves privadas permanecen solo en el entorno del servidor (variables de entorno o archivo <code className="font-mono text-slate-300">.env</code>).
                </p>
              </div>

              {/* Add User Button */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-white">
                  Usuarios API ({users.length})
                </span>
                <button
                  type="button"
                  onClick={handleStartNewUser}
                  className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Agregar Usuario</span>
                </button>
              </div>

              {/* Users List */}
              <div className="space-y-2">
                {users.map((u) => {
                  const isSelected = !isCreatingNew && selectedId === u.id;
                  const isActiveStudio = activeUserId === u.id;
                  return (
                    <div
                      key={u.id}
                      className={`rounded-xl border p-3 transition-colors space-y-2 ${
                        isSelected
                          ? "bg-[#151E2B] border-blue-500/60"
                          : "bg-[#11161F] border-white/10 hover:border-white/25"
                      }`}
                    >
                      <div
                        onClick={() => handleSelectUser(u)}
                        className="cursor-pointer space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white truncate">
                            {u.name}
                          </span>
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 ${
                              u.role === "admin"
                                ? "bg-blue-950/60 border-blue-500/40 text-blue-300"
                                : u.role === "operator"
                                ? "bg-slate-800 border-white/15 text-slate-200"
                                : "bg-zinc-900 border-white/10 text-slate-400"
                            }`}
                          >
                            {u.role}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-400 gap-2">
                          <span className="truncate font-mono">
                            {u.handle || u.id}
                          </span>
                          <span className="shrink-0 font-mono">
                            {u.assignedSlotId} · {u.apiSettings.resolution}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-white/10">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleQuickToggleEnabled(u)}
                          className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 border ${
                            u.enabled
                              ? "bg-emerald-950/40 border-emerald-500/35 text-emerald-300"
                              : "bg-rose-950/40 border-rose-500/35 text-rose-300"
                          }`}
                        >
                          {u.enabled ? (
                            <>
                              <UserCheck className="w-3 h-3" />
                              <span>Activo</span>
                            </>
                          ) : (
                            <>
                              <UserX className="w-3 h-3" />
                              <span>Suspendido</span>
                            </>
                          )}
                        </button>

                        <div className="flex items-center gap-1.5">
                          {isActiveStudio && (
                            <span className="text-[10px] font-semibold text-emerald-400 flex items-center gap-1">
                              <Check className="w-3 h-3" />
                              <span>En uso</span>
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={busy || !u.enabled}
                            onClick={() => void handleQuickApply(u)}
                            className="px-2.5 py-1 rounded bg-[#090C10] hover:bg-blue-600 border border-white/15 hover:border-blue-500 text-[11px] font-medium text-slate-200 hover:text-white disabled:opacity-40"
                          >
                            Aplicar
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* RIGHT COLUMN: Full Editor & Functional API Parameters */}
            <div className="p-5 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    {isCreatingNew
                      ? "Nuevo Usuario API"
                      : `Editar Usuario: ${draft.name || draft.id}`}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Ajusta accesos, permisos, cuenta de servidor asignada y todos los parámetros operativos de la API
                  </p>
                </div>

                {!isCreatingNew && users.length > 1 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteUser()}
                    className="px-2.5 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/40 text-xs font-medium text-rose-200 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Eliminar</span>
                  </button>
                )}
              </div>

              {feedback && (
                <div
                  className={`rounded-xl px-3.5 py-2.5 text-xs border ${
                    feedback.type === "ok"
                      ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-200"
                      : "bg-rose-950/40 border-rose-500/40 text-rose-200"
                  }`}
                >
                  {feedback.text}
                </div>
              )}

              {/* Section 1: Identity, Role & Server Slot */}
              <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  1. Identidad, Acceso y Cuenta del Servidor
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Nombre del Usuario
                    </label>
                    <input
                      type="text"
                      maxLength={64}
                      value={draft.name}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, name: e.target.value }))
                      }
                      placeholder="Ej. Estudio 1"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Identificador / Correo
                    </label>
                    <input
                      type="text"
                      maxLength={80}
                      value={draft.handle}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, handle: e.target.value }))
                      }
                      placeholder="operador@estudio"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Rol de Acceso
                    </label>
                    <select
                      value={draft.role}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          role: e.target.value as ApiUserRole,
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
                    >
                      <option value="admin">Administrador (Total)</option>
                      <option value="operator">Operador</option>
                      <option value="viewer">Visor (Limitado)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Cuenta del Servidor
                    </label>
                    <select
                      value={draft.assignedSlotId}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          assignedSlotId: e.target.value,
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
                    >
                      {keySlots.map((slot, idx) => (
                        <option key={slot.id} value={slot.id}>
                          Cuenta {idx + 1} (
                          {slot.configured ? "Lista" : "Sin clave en servidor"})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Module Permissions + Allowed Models */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-white/10">
                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-slate-300">
                      Permisos de Acceso al Estudio
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {(
                        [
                          { key: "enabled", label: "Usuario Habilitado", isRoot: true },
                          { key: "canUseMobileP2p", label: "Celular P2P", isRoot: false },
                          { key: "canUseUsb", label: "USB (APK)", isRoot: false },
                          { key: "canUseWindowCapture", label: "Capturar Ventana", isRoot: false },
                          { key: "canRecord", label: "Grabar WebM", isRoot: false },
                          { key: "canEditEngineSettings", label: "Ajustar Motor", isRoot: false },
                        ] as const
                      ).map((item) => {
                        const checked = item.isRoot
                          ? draft.enabled
                          : draft.permissions[item.key];
                        return (
                          <label
                            key={item.key}
                            className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const val = e.target.checked;
                                if (item.isRoot) {
                                  setDraft((d) => ({ ...d, enabled: val }));
                                } else {
                                  const permKey = item.key;
                                  setDraft((d) => ({
                                    ...d,
                                    permissions: {
                                      ...d.permissions,
                                      [permKey]: val,
                                    },
                                  }));
                                }
                              }}
                              className="w-3.5 h-3.5 accent-blue-600 rounded"
                            />
                            <span>{item.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-slate-300">
                      Modelos Permitidos para este Usuario
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {LUCY_MODELS.map((m) => {
                        const allowed = draft.allowedModels.includes(m.id);
                        return (
                          <label
                            key={m.id}
                            className="flex items-center justify-between gap-2 text-[11px] text-slate-200 cursor-pointer px-2 py-1 rounded bg-[#090C10]/60 border border-white/5"
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={allowed}
                                onChange={() => toggleAllowedModel(m.id)}
                                className="w-3.5 h-3.5 accent-blue-600 rounded shrink-0"
                              />
                              <span className="truncate">{m.label}</span>
                            </span>
                            <span className="font-mono text-[10px] text-slate-400 shrink-0">
                              {m.versionTag}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Section 2: All Functional API Settings */}
              <div className="rounded-xl bg-[#11161F] border border-white/10 p-4 space-y-3.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  2. Todos los Campos Funcionales de la API
                </h4>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Modelo Inicial
                    </label>
                    <select
                      value={draft.apiSettings.model}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            model: e.target.value as LucyModelId,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
                    >
                      {LUCY_MODELS.filter((m) =>
                        draft.allowedModels.includes(m.id)
                      ).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} ({m.versionTag})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Resolución
                    </label>
                    <select
                      value={draft.apiSettings.resolution}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            resolution: e.target.value as DecartResolution,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
                    >
                      <option value="720p">720p (1280×720)</option>
                      <option value="1080p">1080p (1920×1080)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Códec WebRTC
                    </label>
                    <select
                      value={draft.apiSettings.preferredVideoCodec}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            preferredVideoCodec: e.target.value as DecartCodec,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white uppercase focus:outline-none focus:border-blue-500"
                    >
                      <option value="h264">H.264</option>
                      <option value="vp8">VP8</option>
                      <option value="vp9">VP9</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Espejo de Salida
                    </label>
                    <select
                      value={draft.apiSettings.serverMirror}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            serverMirror: e.target.value as DecartMirrorMode,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 text-xs text-white focus:outline-none focus:border-blue-500"
                    >
                      <option value="off">Desactivado</option>
                      <option value="auto">Auto</option>
                      <option value="always">Siempre</option>
                    </select>
                  </div>
                </div>

                {/* Numeric Parameters */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      TTL Token (s)
                    </label>
                    <input
                      type="number"
                      min={60}
                      max={3600}
                      step={30}
                      value={draft.apiSettings.tokenTtlSeconds}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            tokenTtlSeconds: Math.min(
                              3600,
                              Math.max(60, Number(e.target.value) || 300)
                            ),
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Máx Sesión (s)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={7200}
                      step={30}
                      value={draft.apiSettings.maxSessionSeconds}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            maxSessionSeconds: Math.min(
                              7200,
                              Math.max(0, Number(e.target.value) || 0)
                            ),
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Reintentos (0–5)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={draft.apiSettings.retries}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            retries: Math.min(
                              5,
                              Math.max(0, Number(e.target.value) || 0)
                            ),
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Espera GPU (s)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={120}
                      value={Math.round(
                        draft.apiSettings.capacityRetryBudgetMs / 1000
                      )}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            capacityRetryBudgetMs:
                              Math.min(
                                120,
                                Math.max(0, Number(e.target.value) || 0)
                              ) * 1000,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Timeout Img (s)
                    </label>
                    <input
                      type="number"
                      min={5}
                      max={30}
                      value={Math.round(
                        draft.apiSettings.setImageTimeoutMs / 1000
                      )}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            setImageTimeoutMs:
                              Math.min(
                                30,
                                Math.max(5, Number(e.target.value) || 15)
                              ) * 1000,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* Boolean Flags */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  {(
                    [
                      { key: "fastMode", label: "Fast Mode (Baja latencia)" },
                      { key: "enhancePrompt", label: "Enhance Prompt" },
                      {
                        key: "passthroughOnStart",
                        label: "Passthrough al iniciar",
                      },
                      { key: "debugQuality", label: "Debug Quality" },
                    ] as const
                  ).map((flag) => (
                    <label
                      key={flag.key}
                      className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={draft.apiSettings[flag.key]}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            apiSettings: {
                              ...d.apiSettings,
                              [flag.key]: e.target.checked,
                            },
                          }))
                        }
                        className="w-3.5 h-3.5 accent-blue-600 rounded"
                      />
                      <span>{flag.label}</span>
                    </label>
                  ))}
                </div>

                {/* Optional Endpoints & Default Prompt */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Base URL API (opcional HTTPS)
                    </label>
                    <input
                      type="url"
                      value={draft.apiSettings.customBaseUrl}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            customBaseUrl: e.target.value,
                          },
                        }))
                      }
                      placeholder="Por defecto del servidor"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Realtime URL (opcional WSS/HTTPS)
                    </label>
                    <input
                      type="url"
                      value={draft.apiSettings.customRealtimeUrl}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          apiSettings: {
                            ...d.apiSettings,
                            customRealtimeUrl: e.target.value,
                          },
                        }))
                      }
                      placeholder="Por defecto del servidor"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#090C10] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Prompt Predeterminado del Usuario
                  </label>
                  <textarea
                    rows={3}
                    maxLength={1200}
                    value={draft.apiSettings.defaultPrompt}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        apiSettings: {
                          ...d.apiSettings,
                          defaultPrompt: e.target.value,
                        },
                      }))
                    }
                    className="w-full rounded-lg bg-[#090C10] border border-white/15 px-3 py-2 text-xs text-slate-100 leading-relaxed focus:outline-none focus:border-blue-500 resize-none"
                  />
                </div>
              </div>

              {/* Action Footer */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTestAssignedSlot()}
                  className="px-3 py-2 rounded-lg bg-[#11161F] hover:bg-[#192230] border border-white/15 text-xs font-medium text-slate-200 flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Probar Cuenta Asignada</span>
                </button>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleSaveUser(false)}
                    className="px-3.5 py-2 rounded-lg bg-[#11161F] hover:bg-[#192230] border border-white/15 text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5 text-blue-400" />
                    <span>Guardar Cambios</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy || !draft.enabled}
                    onClick={() => void handleSaveUser(true)}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Guardar y Aplicar al Motor</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
