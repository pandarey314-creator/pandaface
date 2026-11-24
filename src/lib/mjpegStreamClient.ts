import type { UsbRotationDeg } from "../types/studio";

export interface MjpegStreamStats {
  fps: number;
  width: number;
  height: number;
  kbps: number;
}

export interface MjpegTransformConfig {
  rotationDeg: UsbRotationDeg;
}

export interface MjpegStreamOptions {
  streamUrl: string;
  initialRotationDeg?: UsbRotationDeg;
  onStats?: (stats: MjpegStreamStats) => void;
  onLive?: (width: number, height: number) => void;
  onReconnecting?: (attempt: number, reason: string) => void;
  onError?: (message: string) => void;
}

export interface MjpegStreamHandle {
  stream: MediaStream;
  setTransform: (next: Partial<MjpegTransformConfig>) => void;
  stop: () => void;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  fromIndex = 0
): number {
  const limit = haystack.length - needle.length;
  for (let i = fromIndex; i <= limit; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]); // \r\n\r\n
const JPEG_SOI = new Uint8Array([0xff, 0xd8]);
const JPEG_EOI = new Uint8Array([0xff, 0xd9]);

const MAX_RECONNECT_ATTEMPTS = 14;

/**
 * Connects to a same-origin MJPEG proxy stream (/api/usb-cam/stream),
 * decodes each JPEG frame via createImageBitmap without queueing stale frames,
 * applies PC-side 0/90/180/270 rotation on canvas, and keeps the MediaStream alive
 * across brief APK camera/codec restarts.
 */
export function startMjpegCanvasStream(
  options: MjpegStreamOptions
): MjpegStreamHandle {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d", { alpha: false });
  const stream = canvas.captureStream(30);

  let rotationDeg: UsbRotationDeg = options.initialRotationDeg ?? 0;
  let activeAbort: AbortController | null = null;
  let reconnectTimer: number | null = null;
  let stopped = false;
  let pendingJpeg: Uint8Array | null = null;
  let isDecoding = false;
  let hasEverConnected = false;
  let needsLiveNotify = true;
  let lastLiveW = 0;
  let lastLiveH = 0;

  let framesInWindow = 0;
  let bytesInWindow = 0;
  let lastStatsTs = performance.now();

  const statsTimer = window.setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    const dtSec = Math.max(0.25, (now - lastStatsTs) / 1000);
    const fps = Math.round(framesInWindow / dtSec);
    const kbps = Math.round((bytesInWindow * 8) / 1000 / dtSec);
    framesInWindow = 0;
    bytesInWindow = 0;
    lastStatsTs = now;
    options.onStats?.({
      fps,
      width: canvas.width,
      height: canvas.height,
      kbps,
    });
  }, 1000);

  const drawRotatedBitmap = (bitmap: ImageBitmap) => {
    const swapDims = rotationDeg === 90 || rotationDeg === 270;
    const targetW = swapDims ? bitmap.height : bitmap.width;
    const targetH = swapDims ? bitmap.width : bitmap.height;

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    if (!ctx) return;

    if (rotationDeg === 0) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      return;
    }

    ctx.save();
    ctx.translate(targetW / 2, targetH / 2);
    ctx.rotate((rotationDeg * Math.PI) / 180);
    ctx.drawImage(
      bitmap,
      -bitmap.width / 2,
      -bitmap.height / 2,
      bitmap.width,
      bitmap.height
    );
    ctx.restore();
  };

  const scheduleDecode = () => {
    if (stopped || isDecoding || !pendingJpeg) return;
    const jpegBytes = pendingJpeg;
    pendingJpeg = null;
    isDecoding = true;

    const copy = new Uint8Array(jpegBytes.byteLength);
    copy.set(jpegBytes);
    const blob = new Blob([copy.buffer], { type: "image/jpeg" });

    createImageBitmap(blob)
      .then((bitmap) => {
        if (stopped) {
          bitmap.close();
          return;
        }
        drawRotatedBitmap(bitmap);
        framesInWindow++;
        if (!hasEverConnected) {
          hasEverConnected = true;
        }
        if (
          needsLiveNotify ||
          canvas.width !== lastLiveW ||
          canvas.height !== lastLiveH
        ) {
          needsLiveNotify = false;
          lastLiveW = canvas.width;
          lastLiveH = canvas.height;
          options.onLive?.(canvas.width, canvas.height);
        }
        bitmap.close();
      })
      .catch(() => {
        // Ignore occasional partial/corrupt JPEG frame safely
      })
      .finally(() => {
        isDecoding = false;
        if (!stopped && pendingJpeg) {
          scheduleDecode();
        }
      });
  };

  const scheduleReconnect = (attempt: number, reason: string) => {
    if (stopped) return;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      options.onError?.(reason);
      return;
    }
    needsLiveNotify = true;
    options.onReconnecting?.(attempt, reason);
    const delayMs = attempt <= 4 ? 380 : Math.min(1100, 380 + attempt * 80);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        void pump(attempt);
      }
    }, delayMs);
  };

  const pump = async (attempt = 0): Promise<void> => {
    if (stopped) return;
    const controller = new AbortController();
    activeAbort = controller;

    try {
      const response = await fetch(options.streamUrl, {
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok || !response.body) {
        let errMsg = `No se pudo abrir el video USB (HTTP ${response.status}).`;
        try {
          const json = (await response.json()) as { message?: string };
          if (json.message) errMsg = json.message;
        } catch {
          // Non-JSON error body
        }
        if (stopped) return;
        // Retry 502/503/504 when the APK is restarting after a remote camera command
        const retryableStatus =
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;
        if (hasEverConnected && retryableStatus) {
          scheduleReconnect(attempt + 1, errMsg);
        } else {
          options.onError?.(errMsg);
        }
        return;
      }

      const reader = response.body.getReader();
      let buffer: Uint8Array = new Uint8Array(0);
      let expectedLength: number | null = null;
      let receivedAnyFrameThisRun = false;

      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) {
          if (!stopped) {
            if (hasEverConnected || receivedAnyFrameThisRun) {
              scheduleReconnect(
                1,
                "La cámara USB está reiniciando el flujo..."
              );
            } else {
              options.onError?.(
                "La transmisión USB se cerró desde el celular."
              );
            }
          }
          break;
        }
        if (!value || value.length === 0) continue;

        bytesInWindow += value.length;
        buffer = concatUint8(buffer, value);

        while (!stopped) {
          if (expectedLength === null) {
            const soi = indexOfBytes(buffer, JPEG_SOI);
            const headerEnd = indexOfBytes(buffer, HEADER_END);

            if (headerEnd !== -1 && (soi === -1 || headerEnd < soi)) {
              const headerText = new TextDecoder().decode(
                buffer.subarray(0, headerEnd)
              );
              const match = /content-length:\s*(\d+)/i.exec(headerText);
              buffer = buffer.subarray(headerEnd + HEADER_END.length);
              if (match) {
                expectedLength = Number(match[1]);
              } else {
                const nextSoi = indexOfBytes(buffer, JPEG_SOI);
                if (nextSoi > 0) buffer = buffer.subarray(nextSoi);
                const eoi = indexOfBytes(buffer, JPEG_EOI, 2);
                if (eoi === -1) break;
                pendingJpeg = buffer.subarray(0, eoi + 2);
                buffer = buffer.subarray(eoi + 2);
                receivedAnyFrameThisRun = true;
                scheduleDecode();
                continue;
              }
            } else if (soi !== -1 && headerEnd === -1) {
              if (soi > 0) buffer = buffer.subarray(soi);
              const eoi = indexOfBytes(buffer, JPEG_EOI, 2);
              if (eoi === -1) break;
              pendingJpeg = buffer.subarray(0, eoi + 2);
              buffer = buffer.subarray(eoi + 2);
              receivedAnyFrameThisRun = true;
              scheduleDecode();
              continue;
            } else {
              if (buffer.length > 512 * 1024) {
                buffer = buffer.subarray(buffer.length - 4096);
              }
              break;
            }
          }

          if (expectedLength !== null) {
            if (buffer.length < expectedLength) break;
            pendingJpeg = buffer.subarray(0, expectedLength);
            buffer = buffer.subarray(expectedLength);
            expectedLength = null;
            receivedAnyFrameThisRun = true;
            scheduleDecode();
          }
        }
      }
    } catch (err) {
      if (stopped || (err as { name?: string })?.name === "AbortError") {
        return;
      }
      const msg =
        err instanceof Error
          ? `Error de conexión USB: ${err.message}`
          : "Se perdió la conexión USB.";
      if (hasEverConnected) {
        scheduleReconnect(attempt + 1, msg);
      } else {
        options.onError?.(msg);
      }
    }
  };

  void pump(0);

  return {
    stream,
    setTransform: (next) => {
      if (next.rotationDeg !== undefined) {
        rotationDeg = next.rotationDeg;
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(statsTimer);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      activeAbort?.abort();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
