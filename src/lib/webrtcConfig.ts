export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 4,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};

/**
 * Generates a clean 6-character alphanumeric room code (avoiding ambiguous O/0, I/1).
 */
export function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

/**
 * Builds WebSocket signaling URL matching the current HTTP/HTTPS origin.
 */
export function getSignalWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/signal`;
}

/**
 * Prioritizes hardware-accelerated low-latency video codecs (H264 / VP8) in SDP.
 */
export function prioritizeLowLatencyCodecs(sdp: string): string {
  const lines = sdp.split("\r\n");
  const mLineIdx = lines.findIndex((line) => line.startsWith("m=video "));
  if (mLineIdx === -1) return sdp;

  const preferredPayloads: string[] = [];
  const otherPayloads: string[] = [];

  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+(H264|VP8)\//i);
    if (match) {
      preferredPayloads.push(match[1]);
    }
  }

  if (preferredPayloads.length === 0) return sdp;

  const mParts = lines[mLineIdx].split(" ");
  const header = mParts.slice(0, 3);
  const existingPayloads = mParts.slice(3);

  for (const pt of existingPayloads) {
    if (!preferredPayloads.includes(pt)) {
      otherPayloads.push(pt);
    }
  }

  const reordered = [
    ...preferredPayloads.filter((pt) => existingPayloads.includes(pt)),
    ...otherPayloads,
  ];
  lines[mLineIdx] = [...header, ...reordered].join(" ");
  return lines.join("\r\n");
}

/**
 * Configures RTCRtpSender for minimal latency and smooth framerate over resolution.
 */
export async function tuneVideoSenderForLowLatency(
  pc: RTCPeerConnection,
  maxBitrateBps = 2_800_000,
  maxFramerate = 30
): Promise<void> {
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (sender.track?.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.degradationPreference = "maintain-framerate";
      params.encodings[0].maxBitrate = maxBitrateBps;
      params.encodings[0].maxFramerate = maxFramerate;
      params.encodings[0].networkPriority = "high";
      await sender.setParameters(params);
    } catch {
      // Browser may restrict some parameter mutations; ignore gracefully
    }
  }
}

/**
 * Fetches an image URL (e.g. a local preset portrait) and returns a File ready for Decart SDK.
 */
export async function imageUrlToFile(
  url: string,
  fileName = "reference-face.jpg"
): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo cargar la imagen de referencia (${res.status})`);
  }
  const blob = await res.blob();
  return new File([blob], fileName, { type: blob.type || "image/jpeg" });
}
