"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type Peer from "peerjs";
import type { DataConnection } from "peerjs";
import {
  BRIDGE_URL,
  DEFAULT_MODE,
  MODES,
  PEER_PREFIX,
  flagsMode,
  isMode,
  newRoomCode,
  normaliseCode,
  peerOptions,
  type Mode,
} from "@/lib/protocol";

// The PC screen. Phones connect here over WebRTC; every phone's input is
// passed on to the Tilt Wheel bridge running on this PC (ws://127.0.0.1),
// which turns it into a virtual Xbox 360 controller.

const HOST_KEY = "tiltwheel2-host";
const HOST_MODE_KEY = "tiltwheel2-host-mode";

type Player = {
  id: string;
  num: number;
  conn: DataConnection;
  ws: WebSocket | null;
  lastSeq: number;
  steer: number;
  gas: number;
  brake: number;
  flags: number;
  lastSeen: number;
};

type PlayerView = { id: string; num: number; steer: number; gas: number; brake: number; mode: Mode; padOk: boolean; stale: boolean };

type PeerState = "starting" | "online" | "offline";

export default function Host() {
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [peerState, setPeerState] = useState<PeerState>("starting");
  const [peerMsg, setPeerMsg] = useState("");
  const [bridgeOk, setBridgeOk] = useState(false);
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  const [views, setViews] = useState<PlayerView[]>([]);

  const players = useRef(new Map<string, Player>());
  const bridgeOkRef = useRef(false);

  // ---------- Room code + saved mode ----------
  useEffect(() => {
    let c = "";
    try {
      c = normaliseCode(localStorage.getItem(HOST_KEY) || "");
      const m = localStorage.getItem(HOST_MODE_KEY);
      if (isMode(m)) setMode(m);
    } catch {}
    if (c.length !== 6) {
      c = newRoomCode();
      try {
        localStorage.setItem(HOST_KEY, c);
      } catch {}
    }
    setCode(c);
  }, []);

  useEffect(() => {
    if (!code) return;
    const url = `${location.origin}/play?r=${code}`;
    setJoinUrl(url);
    QRCode.toDataURL(url, { margin: 1, width: 560, errorCorrectionLevel: "M" }).then(setQr, () => setQr(""));
  }, [code]);

  const send = (p: Player, msg: object) => {
    try {
      if (p.conn.open) p.conn.send(JSON.stringify(msg));
    } catch {}
  };

  // ---------- Bridge (local Python app) ----------
  const openPad = useCallback((p: Player) => {
    if (!bridgeOkRef.current || p.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${BRIDGE_URL}/pad?player=${p.num}`);
    } catch {
      return;
    }
    p.ws = ws;
    ws.onclose = () => {
      if (p.ws === ws) p.ws = null;
    };
    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    let status: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const setOk = (ok: boolean) => {
      if (bridgeOkRef.current === ok) return;
      bridgeOkRef.current = ok;
      setBridgeOk(ok);
      for (const p of players.current.values()) {
        send(p, { type: "bridge", ok });
        if (ok) openPad(p);
      }
    };
    const connect = () => {
      if (disposed) return;
      try {
        status = new WebSocket(`${BRIDGE_URL}/status`);
      } catch {
        timer = setTimeout(connect, 2000);
        return;
      }
      status.onopen = () => setOk(true);
      status.onclose = () => {
        setOk(false);
        if (!disposed) timer = setTimeout(connect, 2000);
      };
      status.onerror = () => status?.close();
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      status?.close();
    };
  }, [openPad]);

  // ---------- WebRTC host ----------
  useEffect(() => {
    if (!code) return;
    let peer: Peer | null = null;
    let disposed = false;
    let takenRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout>;

    const nextNum = () => {
      const used = new Set([...players.current.values()].map((p) => p.num));
      let n = 1;
      while (used.has(n)) n++;
      return n;
    };

    const drop = (id: string) => {
      const p = players.current.get(id);
      if (!p) return;
      players.current.delete(id);
      p.ws?.close(); // the bridge releases the pad and resets it to rest
    };

    const onConnection = (conn: DataConnection) => {
      const id = conn.connectionId;
      conn.on("open", () => {
        const p: Player = {
          id,
          num: nextNum(),
          conn,
          ws: null,
          lastSeq: 0,
          steer: 0,
          gas: 0,
          brake: 0,
          flags: 1,
          lastSeen: performance.now(),
        };
        players.current.set(id, p);
        send(p, { type: "hello", player: p.num, bridge: bridgeOkRef.current });
        openPad(p);
      });
      conn.on("data", (raw) => {
        const p = players.current.get(id);
        if (!p || typeof raw !== "string") return;
        let a: unknown;
        try {
          a = JSON.parse(raw);
        } catch {
          return;
        }
        if (!Array.isArray(a) || a.length < 5) return;
        const seq = Number(a[5]) || 0;
        if (seq && seq <= p.lastSeq) return; // late packet on the unordered channel
        p.lastSeq = seq;
        p.steer = Number(a[0]) || 0;
        p.gas = Number(a[1]) || 0;
        p.brake = Number(a[2]) || 0;
        p.flags = Number(a[4]) || 0;
        p.lastSeen = performance.now();
        if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(a.slice(0, 5)));
        else openPad(p);
      });
      conn.on("close", () => drop(id));
      conn.on("error", () => drop(id));
    };

    const start = async () => {
      const { default: PeerCtor } = await import("peerjs");
      if (disposed) return;
      setPeerState("starting");
      peer = new PeerCtor(PEER_PREFIX + code, peerOptions());
      peer.on("open", () => {
        takenRetries = 0;
        setPeerState("online");
        setPeerMsg("");
      });
      peer.on("connection", onConnection);
      peer.on("disconnected", () => {
        setPeerState("offline");
        setPeerMsg("Lost the connection to the pairing server. Reconnecting…");
        retryTimer = setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500);
      });
      peer.on("error", (err: any) => {
        if (err?.type === "unavailable-id") {
          // usually this page was just reloaded and the old session hasn't expired yet
          peer?.destroy();
          if (++takenRetries <= 5) {
            setPeerMsg("This code is still in use (another tab open?). Retrying…");
            retryTimer = setTimeout(start, 3000);
          } else {
            setPeerMsg("Code is in use elsewhere, made a new one.");
            const c = newRoomCode();
            try {
              localStorage.setItem(HOST_KEY, c);
            } catch {}
            setCode(c);
          }
        } else if (["network", "server-error", "socket-error", "socket-closed"].includes(err?.type)) {
          setPeerState("offline");
          setPeerMsg("Can't reach the pairing server. Check this PC's internet connection.");
          if (peer?.destroyed) retryTimer = setTimeout(start, 3000);
        }
      });
    };
    start();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      for (const id of [...players.current.keys()]) drop(id);
      peer?.destroy();
    };
  }, [code, openPad]);

  // ---------- Live view (10 Hz is plenty for a status panel) ----------
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      setViews(
        [...players.current.values()]
          .sort((a, b) => a.num - b.num)
          .map((p) => ({
            id: p.id,
            num: p.num,
            steer: p.steer,
            gas: p.gas,
            brake: p.brake,
            mode: flagsMode(p.flags),
            padOk: p.ws?.readyState === WebSocket.OPEN,
            stale: now - p.lastSeen > 1500,
          })),
      );
    }, 100);
    return () => clearInterval(t);
  }, []);

  const chooseMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(HOST_MODE_KEY, m);
    } catch {}
    for (const p of players.current.values()) send(p, { type: "mode", mode: m });
  };

  const newCode = () => {
    const c = newRoomCode();
    try {
      localStorage.setItem(HOST_KEY, c);
    } catch {}
    setCode(c);
  };

  return (
    <main className="host">
      <div className="hostInner">
        <header className="hostHead">
          <h1>
            Tilt <span>Wheel</span>
          </h1>
          <p>Your phone as a gyro steering wheel for PC racing games.</p>
        </header>

        <div className="hostGrid">
          <section className="card">
            <h2>Scan with your phone</h2>
            <div className="qr">{qr ? <img src={qr} alt={`QR code for ${joinUrl}`} /> : <span className="wait">Making code…</span>}</div>
            <div className="code">
              <small>or open {joinUrl ? new URL(joinUrl).host + "/play" : "/play"} and type</small>
              <b>{code ?? "······"}</b>
            </div>
            <div className="statusLine">
              <span className={"dot " + (peerState === "online" ? "ok" : peerState === "offline" ? "bad" : "")} />
              <span className="grow">
                {peerState === "online" ? "Ready for phones" : peerState === "offline" ? "Offline" : "Starting…"}
              </span>
              <button className="chip" onClick={newCode}>
                New code
              </button>
            </div>
            {peerMsg && <p className="note">{peerMsg}</p>}
            <p className="note">Keep this tab open while you play. It can sit behind the game.</p>
          </section>

          <div style={{ display: "grid", gap: 24 }}>
            <section className="card">
              <h2>Controllers</h2>
              <div className="statusLine">
                <span className={"dot " + (bridgeOk ? "ok" : "bad")} />
                <span className="grow">
                  {bridgeOk ? "Bridge app running: games will see Xbox controllers" : "Bridge app not running on this PC"}
                </span>
              </div>
              {views.length === 0 ? (
                <p className="empty">No phones yet. Scan the QR code, tap Start on the phone, and it shows up here.</p>
              ) : (
                <div className="players">
                  {views.map((v) => (
                    <div className="player" key={v.id}>
                      <div className="num">{v.num}</div>
                      <div className="meta">
                        <b>
                          Controller {v.num}
                          {v.stale ? " · no signal" : ""}
                        </b>
                        <div className="meters">
                          <div className="meter steer" title="Steering">
                            <i style={{ left: `${50 + v.steer * 48}%` }} />
                          </div>
                          <div className="meter gas" title="Gas">
                            <i style={{ width: `${v.gas * 100}%` }} />
                          </div>
                          <div className="meter brake" title="Brake">
                            <i style={{ width: `${v.brake * 100}%` }} />
                          </div>
                        </div>
                      </div>
                      <div className="tag">
                        {MODES.find((m) => m.id === v.mode)!.short}
                        {v.padOk ? "" : " · no pad"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="card">
              <h2>Mode for all phones</h2>
              <div className="modes">
                {MODES.map((m) => (
                  <button key={m.id} className={"mode" + (mode === m.id ? " on" : "")} onClick={() => chooseMode(m.id)}>
                    <span className="radio" />
                    <b>
                      {m.label}
                      {m.id === DEFAULT_MODE && <em>Default</em>}
                    </b>
                    <span>{m.help}</span>
                  </button>
                ))}
              </div>
              <p className="note">Picking a mode here switches every connected phone. Each phone can also change it in its own Settings.</p>
            </section>

            {!bridgeOk && <BridgeHelp />}

            <section className="card">
              <h2>Button map</h2>
              <table className="map">
                <tbody>
                  <tr><td>Tilt</td><td>Left stick X</td></tr>
                  <tr><td>Gas</td><td>Sim: right stick Y · Gamepad: RT</td></tr>
                  <tr><td>Brake</td><td>Sim: right stick X · Gamepad: LT</td></tr>
                  <tr><td>Handbrake / Boost / Camera</td><td>A / B / Y</td></tr>
                  <tr><td>Gear down / up</td><td>LB / RB</td></tr>
                  <tr><td>Pause</td><td>Start</td></tr>
                </tbody>
              </table>
              <p className="note">
                In sim games (ACC, Assetto Corsa, rFactor 2) bind Steer by tilting, Throttle by pressing Gas and Brake by pressing Brake in the game&apos;s controls screen.
              </p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function BridgeHelp() {
  return (
    <section className="card">
      <h2>One-time setup on this PC</h2>
      <p className="note">
        A web page can&apos;t create a game controller by itself, so a tiny helper app turns your phone into a virtual Xbox 360 controller.
      </p>
      <a className="dl" href="/TiltWheelBridge.zip" download>
        Download bridge app
      </a>
      <ol className="steps">
        <li>Install Python 3.10+ from python.org (tick &quot;Add Python to PATH&quot;).</li>
        <li>Unzip and double-click <code>Start.bat</code>. On first run accept the ViGEmBus driver installer, and restart if asked.</li>
        <li>Come back here. The dot above turns green within a couple of seconds.</li>
      </ol>
      <p className="note">
        Still red with the bridge running? Click the lock icon in the address bar and allow access to apps on this device (local network access), then reload.
      </p>
    </section>
  );
}
