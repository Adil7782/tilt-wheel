// Shared between the phone (controller) and the PC page (host).
//
// Phone -> host, every change + a 200 ms heartbeat, as a JSON array:
//   [steer -1..1, gas 0..1, brake 0..1, buttonBits, flags]
// The host forwards that string untouched to the local bridge, which drives
// a virtual Xbox 360 pad. flags: 1 = sim racing axes, 2 = reversed pedals.
//
// Host -> phone, JSON objects:
//   { type: "hello", player }   once the connection is up
//   { type: "mode", mode }      the PC changed the mode for every phone

export type Mode = "sim" | "simrev" | "gamepad";

export const DEFAULT_MODE: Mode = "sim";

export const MODES: { id: Mode; label: string; short: string; help: string }[] = [
  {
    id: "sim",
    label: "Sim Racing",
    short: "Sim",
    help: "Gas and brake on separate axes (right stick Y / X). For games set to Wheel controls: ACC, Assetto Corsa, rFactor 2…",
  },
  {
    id: "simrev",
    label: "Sim Racing, reversed pedals",
    short: "Sim rev",
    help: "Same as Sim Racing, but the pedal axes are flipped. Use it if a pedal reads 100% when released.",
  },
  {
    id: "gamepad",
    label: "Gamepad",
    short: "Gamepad",
    help: "Gas on RT, brake on LT. For normal controller games like Forza, Need for Speed, GTA.",
  },
];

export const modeFlags = (m: Mode) => (m === "sim" ? 1 : m === "simrev" ? 3 : 0);

export const flagsMode = (f: number): Mode => (f & 1 ? (f & 2 ? "simrev" : "sim") : "gamepad");

export const isMode = (v: unknown): v is Mode => v === "sim" || v === "simrev" || v === "gamepad";

// Room codes become PeerJS ids. Short and without look-alike characters
// so they can be typed by hand when a camera isn't handy.
export const PEER_PREFIX = "tiltwheel-v2-";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const normaliseCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

export const BRIDGE_URL = "ws://127.0.0.1:8765";

// Optional self-hosted PeerJS server, e.g. NEXT_PUBLIC_PEER_HOST=peer.example.com
export function peerOptions() {
  const host = process.env.NEXT_PUBLIC_PEER_HOST;
  const base = {
    debug: 0,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
    },
  };
  if (!host) return base;
  return {
    ...base,
    host,
    port: Number(process.env.NEXT_PUBLIC_PEER_PORT || 443),
    path: process.env.NEXT_PUBLIC_PEER_PATH || "/",
    secure: true,
  };
}
