"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type Peer from "peerjs";
import type { DataConnection } from "peerjs";
import {
  DEFAULT_MODE,
  MODES,
  PEER_PREFIX,
  isMode,
  modeFlags,
  normaliseCode,
  peerOptions,
  type Mode,
} from "@/lib/protocol";

// ---------- Settings ----------
type Settings = {
  mode: Mode;
  range: number; // degrees of tilt for full lock; lower = more sensitive
  dead: number; // degrees ignored around centre
  smooth: number; // 0..0.9 low-pass on the steering value
  curve: number; // 1 = linear, >1 = finer control near centre
  pedalMin: number; // pressure at the bottom of a pedal, 0..0.6
  invert: boolean;
  analog: boolean; // slide pedals for partial pressure
  fusion: boolean; // blend the gyroscope with gravity tilt
  vibrate: boolean;
};

const DEFAULTS: Settings = {
  mode: DEFAULT_MODE,
  range: 40,
  dead: 1.5,
  smooth: 0.2,
  curve: 1,
  pedalMin: 0.3,
  invert: false,
  analog: true,
  fusion: true,
  vibrate: true,
};
const SETTINGS_KEY = "tiltwheel2";
const ROOM_KEY = "tiltwheel2-room";

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    if (!isMode(s.mode)) s.mode = DEFAULT_MODE;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

const BUTTONS = [
  { bit: 16, label: "Gear down", key: "LB" },
  { bit: 1, label: "Handbrake", key: "A", hand: true },
  { bit: 32, label: "Gear up", key: "RB" },
  { bit: 8, label: "Camera", key: "Y" },
  { bit: 2, label: "Boost", key: "B" },
  { bit: 64, label: "Pause", key: "Start" },
];

type Status = { text: string; kind?: "ok" | "warn" | "bad" };

export default function Controller() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [room, setRoom] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [screen, setScreen] = useState<"loading" | "join" | "start" | "drive">("loading");
  const [startErr, setStartErr] = useState("");
  const [status, setStatus] = useState<Status>({ text: "Connecting to PC…" });
  const [sheetOpen, setSheetOpen] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // live input state, read by the send loop
  const input = useRef({ steer: 0, gas: 0, brake: 0, bits: 0 });
  const sensor = useRef({
    zero: null as number | null,
    angle: null as number | null, // fused wheel angle, degrees
    prevGrav: null as number | null,
    lastTs: 0,
    gyroSign: 0, // learnt relation between gyro z-rate and gravity angle (differs per platform)
    corr: 0,
    seen: false,
    smoothed: 0,
  });

  const carRef = useRef<HTMLDivElement>(null);
  const angleRef = useRef<HTMLDivElement>(null);
  const roadRef = useRef<HTMLDivElement>(null);
  const brakeRef = useRef<HTMLDivElement>(null);
  const gasRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);

  const connRef = useRef<DataConnection | null>(null);
  const playerRef = useRef<number | null>(null);
  const bridgeOkRef = useRef<boolean | null>(null);

  // ---------- First load: settings + room code ----------
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    const params = new URLSearchParams(location.search);
    let code = normaliseCode(params.get("r") || "");
    if (code) store(ROOM_KEY, code);
    else {
      try {
        code = normaliseCode(localStorage.getItem(ROOM_KEY) || "");
      } catch {}
    }
    if (code.length === 6) {
      setRoom(code);
      setScreen("start");
    } else setScreen("join");
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      store(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const showStatus = useCallback(() => {
    const p = playerRef.current;
    const mode = MODES.find((m) => m.id === settingsRef.current.mode)!;
    if (p == null) return;
    if (bridgeOkRef.current === false)
      setStatus({ text: `Controller ${p} · PC bridge app not running`, kind: "warn" });
    else setStatus({ text: `Controller ${p} · ${mode.label}`, kind: "ok" });
  }, []);

  useEffect(() => {
    showStatus();
  }, [settings.mode, showStatus]);

  // ---------- Gyro + tilt ----------
  // Gravity projected onto the screen plane gives an absolute wheel angle that
  // never drifts but is noisy. The gyroscope's rotation around the screen
  // normal is smooth and instant but drifts. A complementary filter blends both.
  const onMotion = useCallback((e: DeviceMotionEvent) => {
    const st = sensor.current;
    const g = e.accelerationIncludingGravity;
    const dt = st.lastTs ? Math.min(0.1, Math.max(0, (e.timeStamp - st.lastTs) / 1000)) : 0;
    st.lastTs = e.timeStamp;

    let grav: number | null = null;
    if (g && g.x != null && g.y != null && Math.hypot(g.x, g.y) >= 2.5) {
      grav = (Math.atan2(g.y, g.x) * 180) / Math.PI;
    }
    const rate = e.rotationRate?.alpha ?? null;

    // learn the gyro's sign by comparing it with how the gravity angle moves
    if (grav != null && st.prevGrav != null && rate != null && dt > 0) {
      const dG = wrap180(grav - st.prevGrav) / dt;
      if (Math.abs(rate) > 30 && Math.abs(dG) > 15) {
        st.corr = Math.max(-30, Math.min(30, st.corr + Math.sign(rate * dG)));
        if (Math.abs(st.corr) >= 8) st.gyroSign = Math.sign(st.corr);
      }
    }
    if (grav != null) st.prevGrav = grav;

    const useGyro = settingsRef.current.fusion && st.gyroSign !== 0 && rate != null;
    if (st.angle == null) {
      if (grav == null) return;
      st.angle = grav;
    } else if (useGyro) {
      st.angle = wrap180(st.angle + st.gyroSign * rate! * dt);
      if (grav != null) st.angle = wrap180(st.angle + 0.04 * wrap180(grav - st.angle));
    } else if (grav != null) {
      st.angle = grav;
    }
    st.seen = true;
    if (st.zero == null) st.zero = st.angle;
  }, []);

  const centre = useCallback(() => {
    const st = sensor.current;
    if (st.angle != null) st.zero = st.angle;
    st.smoothed = 0;
  }, []);

  // ---------- Pedals & buttons (imperative, multi-touch) ----------
  useEffect(() => {
    if (screen !== "drive") return;
    const cleanups: (() => void)[] = [];
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window | Document,
      type: K | string,
      fn: (e: any) => void,
      opts: AddEventListenerOptions = { passive: false },
    ) => {
      el.addEventListener(type, fn, opts);
      cleanups.push(() => el.removeEventListener(type, fn, opts));
    };

    const bindPedal = (el: HTMLDivElement, key: "gas" | "brake") => {
      const fill = el.querySelector<HTMLDivElement>(".fill")!;
      const touches = new Map<number | string, number>();
      let wasOn = false;
      const refresh = () => {
        const s = settingsRef.current;
        let v = 0;
        if (touches.size) {
          if (!s.analog) v = 1;
          else {
            const r = el.getBoundingClientRect();
            for (const y of touches.values()) {
              const p = 1 - (y - r.top) / r.height;
              v = Math.max(v, s.pedalMin + (1 - s.pedalMin) * Math.max(0, Math.min(1, p)));
            }
          }
        }
        input.current[key] = v;
        fill.style.height = v * 100 + "%";
        el.classList.toggle("on", v > 0);
        if (v > 0 && !wasOn && s.vibrate) navigator.vibrate?.(8);
        wasOn = v > 0;
      };
      on(el, "touchstart", (e: TouchEvent) => {
        e.preventDefault();
        for (const t of e.changedTouches) touches.set(t.identifier, t.clientY);
        refresh();
      });
      on(el, "touchmove", (e: TouchEvent) => {
        e.preventDefault();
        for (const t of e.changedTouches) if (touches.has(t.identifier)) touches.set(t.identifier, t.clientY);
        refresh();
      });
      const up = (e: TouchEvent) => {
        e.preventDefault();
        for (const t of e.changedTouches) touches.delete(t.identifier);
        refresh();
      };
      on(el, "touchend", up);
      on(el, "touchcancel", up);
      // mouse fallback for testing on a computer
      on(el, "mousedown", (e: MouseEvent) => {
        touches.set("m", e.clientY);
        refresh();
      });
      on(window, "mousemove", (e: MouseEvent) => {
        if (touches.has("m")) {
          touches.set("m", e.clientY);
          refresh();
        }
      });
      on(window, "mouseup", () => {
        if (touches.delete("m")) refresh();
      });
    };
    bindPedal(brakeRef.current!, "brake");
    bindPedal(gasRef.current!, "gas");

    padRef.current!.querySelectorAll<HTMLButtonElement>(".btn").forEach((b) => {
      const bit = Number(b.dataset.bit);
      const press = (e: Event) => {
        e.preventDefault();
        input.current.bits |= bit;
        b.classList.add("on");
        if (settingsRef.current.vibrate) navigator.vibrate?.(10);
      };
      const release = (e: Event) => {
        e.preventDefault();
        input.current.bits &= ~bit;
        b.classList.remove("on");
      };
      on(b, "touchstart", press);
      on(b, "touchend", release);
      on(b, "touchcancel", release);
      on(b, "mousedown", press);
      on(b, "mouseup", release);
      on(b, "mouseleave", release);
    });

    // block page scrolling / zoom everywhere except the settings sheet
    on(document, "touchmove", (e: TouchEvent) => {
      if (!(e.target as HTMLElement).closest(".sheet")) e.preventDefault();
    });
    on(document, "gesturestart", (e: Event) => e.preventDefault());

    // release everything if the app is backgrounded
    on(document, "visibilitychange", () => {
      if (document.hidden) {
        Object.assign(input.current, { gas: 0, brake: 0, bits: 0 });
        document.querySelectorAll(".ctl .on").forEach((el) => el.classList.remove("on"));
        document.querySelectorAll<HTMLDivElement>(".ctl .fill").forEach((f) => (f.style.height = "0"));
      }
    });

    return () => cleanups.forEach((f) => f());
  }, [screen]);

  // ---------- Connection to the PC page (WebRTC via PeerJS) ----------
  useEffect(() => {
    if (screen !== "drive" || !room) return;
    let peer: Peer | null = null;
    let disposed = false;
    let connecting = false;
    let lastError = "";

    const handleData = (raw: unknown) => {
      let m: any;
      try {
        m = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return;
      }
      if (m?.type === "hello") {
        playerRef.current = m.player;
        bridgeOkRef.current = m.bridge ?? null;
        showStatus();
      } else if (m?.type === "mode" && isMode(m.mode)) {
        updateSettings({ mode: m.mode });
      } else if (m?.type === "bridge") {
        bridgeOkRef.current = !!m.ok;
        showStatus();
      }
    };

    const connect = () => {
      if (!peer || peer.destroyed || peer.disconnected || connecting) return;
      connecting = true;
      if (!playerRef.current) setStatus({ text: lastError || "Connecting to PC…" });
      const conn = peer.connect(PEER_PREFIX + room, { reliable: false, serialization: "raw" });
      const giveUp = setTimeout(() => {
        if (!conn.open) {
          connecting = false;
          conn.close();
        }
      }, 8000);
      conn.on("open", () => {
        clearTimeout(giveUp);
        connecting = false;
        lastError = "";
        connRef.current = conn;
        setStatus({ text: "Connected to PC", kind: "ok" });
      });
      conn.on("data", handleData);
      conn.on("close", () => {
        clearTimeout(giveUp);
        connecting = false;
        if (connRef.current === conn) connRef.current = null;
        playerRef.current = null;
        if (!disposed) setStatus({ text: "PC disconnected. Reconnecting…", kind: "bad" });
      });
      conn.on("error", () => {
        connecting = false;
        conn.close();
      });
    };

    const makePeer = async () => {
      const { default: PeerCtor } = await import("peerjs");
      if (disposed) return;
      peer = new PeerCtor(peerOptions());
      peer.on("open", connect);
      peer.on("disconnected", () => {
        if (!disposed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1000);
      });
      peer.on("error", (err: any) => {
        connecting = false;
        if (err?.type === "peer-unavailable") {
          lastError = `PC page with code ${room} isn't open. Retrying…`;
          setStatus({ text: lastError, kind: "bad" });
        } else if (err?.type === "network" || err?.type === "server-error" || err?.type === "socket-error") {
          setStatus({ text: "No internet connection. Retrying…", kind: "bad" });
        }
      });
    };
    makePeer();

    // supervisor: recover from sleeping phones, dropped Wi-Fi, PC page reloads
    const watchdog = setInterval(() => {
      if (!peer) return;
      if (peer.destroyed) {
        makePeer();
        return;
      }
      if (peer.disconnected) {
        peer.reconnect();
        return;
      }
      if (!connRef.current?.open) connect();
    }, 2500);

    return () => {
      disposed = true;
      clearInterval(watchdog);
      connRef.current = null;
      peer?.destroy();
    };
  }, [screen, room, showStatus, updateSettings]);

  // ---------- Main loop: steering, read-out, sending ----------
  useEffect(() => {
    if (screen !== "drive") return;
    let raf = 0;
    let lastSent = "";
    let lastSendTime = 0;
    let seq = 0;
    const loop = (t: number) => {
      const s = settingsRef.current;
      const st = sensor.current;

      let target = 0;
      if (st.angle != null && st.zero != null) {
        let d = wrap180(st.angle - st.zero);
        if (s.invert) d = -d;
        const live = Math.max(0, Math.abs(d) - s.dead);
        const span = Math.max(1, s.range - s.dead);
        const lin = Math.min(1, live / span);
        target = Math.sign(d) * Math.pow(lin, s.curve);
      }
      st.smoothed += (target - st.smoothed) * (1 - s.smooth);
      if (Math.abs(st.smoothed) < 0.001) st.smoothed = 0;
      input.current.steer = st.smoothed;

      const road = roadRef.current;
      if (road && carRef.current && angleRef.current) {
        const half = road.clientWidth * 0.42 - 17;
        carRef.current.style.transform = `translateX(${st.smoothed * half}px) rotate(${st.smoothed * 25}deg)`;
        angleRef.current.textContent = Math.round(st.smoothed * 100) + "%";
      }

      const i = input.current;
      const body = [+i.steer.toFixed(3), +i.gas.toFixed(3), +i.brake.toFixed(3), i.bits, modeFlags(s.mode)];
      const key = JSON.stringify(body);
      const conn = connRef.current;
      if (conn?.open && (key !== lastSent || t - lastSendTime > 200)) {
        // the channel is unordered for low latency; seq lets the PC drop stale packets
        try {
          conn.send(JSON.stringify([...body, ++seq]));
          lastSent = key;
          lastSendTime = t;
        } catch {}
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [screen]);

  // ---------- Keep the screen awake ----------
  useEffect(() => {
    if (screen !== "drive") return;
    let lock: any = null;
    const acquire = async () => {
      try {
        lock = await (navigator as any).wakeLock?.request("screen");
      } catch {}
    };
    const onVis = () => {
      if (!document.hidden) acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release?.().catch?.(() => {});
    };
  }, [screen]);

  // ---------- Start ----------
  const start = async () => {
    setStartErr("");
    try {
      if (!window.isSecureContext) throw new Error("Motion sensors need the https:// address.");
      const DME = (window as any).DeviceMotionEvent;
      if (DME && typeof DME.requestPermission === "function") {
        const res = await DME.requestPermission();
        if (res !== "granted")
          throw new Error("Motion access was denied. Close this tab, reopen the link, and tap Allow.");
      }
      window.addEventListener("devicemotion", onMotion);
      // Android: go full screen and lock landscape where allowed
      try {
        if (!window.matchMedia("(display-mode: fullscreen)").matches && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen({ navigationUI: "hide" });
        }
        await (window.screen as any).orientation?.lock?.("landscape");
      } catch {}
      setScreen("drive");
      setTimeout(centre, 400);
      setTimeout(() => {
        if (!sensor.current.seen)
          setStatus({ text: "No tilt data. On iPhone: Settings › Safari › Motion & Orientation Access.", kind: "bad" });
      }, 2500);
    } catch (e: any) {
      setStartErr(e?.message || String(e));
    }
  };
  useEffect(() => () => window.removeEventListener("devicemotion", onMotion), [onMotion]);

  const join = () => {
    const code = normaliseCode(codeDraft);
    if (code.length !== 6) return;
    store(ROOM_KEY, code);
    setRoom(code);
    setScreen("start");
    history.replaceState(null, "", "/play?r=" + code);
  };

  const changePc = () => {
    setSheetOpen(false);
    store(ROOM_KEY, "");
    setRoom(null);
    setCodeDraft("");
    setScreen("join");
    playerRef.current = null;
    history.replaceState(null, "", "/play");
  };

  const mode = MODES.find((m) => m.id === settings.mode)!;

  return (
    <div className="ctl">
      <div className="app">
        <div className="pedal brake" ref={brakeRef}>
          <div className="fill" />
          <small>Slide up to brake harder</small>
          <span>Brake</span>
        </div>

        <div className="mid">
          <div className="top">
            <div className="status">
              <span className={"dot" + (status.kind ? " " + status.kind : "")} />
              <span>{status.text}</span>
            </div>
            <button className="chip" onClick={centre}>
              Centre wheel
            </button>
            <button className="chip" onClick={() => setSheetOpen(true)}>
              Settings
            </button>
          </div>

          <div className="road" ref={roadRef}>
            <div className="edge l" />
            <div className="edge r" />
            <div className="centre" />
            <div className="car" ref={carRef} />
            <div className="modeTag">{mode.label}</div>
            <div className="angle" ref={angleRef}>
              0%
            </div>
          </div>

          <div className="pad" ref={padRef}>
            {BUTTONS.map((b) => (
              <button key={b.bit} className={"btn" + (b.hand ? " hand" : "")} data-bit={b.bit}>
                {b.label}
                <i>{b.key}</i>
              </button>
            ))}
          </div>
        </div>

        <div className="pedal gas" ref={gasRef}>
          <div className="fill" />
          <small>Slide up for more power</small>
          <span>Gas</span>
        </div>
      </div>

      {screen === "loading" && <div className="cover" />}

      {screen === "join" && (
        <div className="cover">
          <h1>Tilt Wheel</h1>
          <p>
            Open <b style={{ color: "var(--chalk)" }}>{typeof location !== "undefined" ? location.host : ""}</b> on
            your PC and scan its QR code with your camera, or type the code shown there.
          </p>
          <div className="coverRow">
            <input
              className="codeInput"
              value={codeDraft}
              onChange={(e) => setCodeDraft(normaliseCode(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && join()}
              placeholder="CODE"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              aria-label="Code from your PC"
            />
            <button className="go" onClick={join} disabled={codeDraft.length !== 6}>
              Join
            </button>
          </div>
        </div>
      )}

      {screen === "start" && (
        <div className="cover">
          <h1>Tilt Wheel</h1>
          <p>
            Hold your phone sideways like a steering wheel, then tap Start. Joining PC <b style={{ color: "var(--line)" }}>{room}</b>.
          </p>
          <button className="go" onClick={start}>
            Start
          </button>
          {startErr && <p className="err">{startErr}</p>}
          <button className="ghost" onClick={changePc}>
            Use a different PC
          </button>
        </div>
      )}

      <div className="cover rotate">
        <div className="phone" />
        <p>Turn your phone sideways to drive.</p>
      </div>

      {sheetOpen && (
        <div className="sheet" onClick={(e) => e.target === e.currentTarget && setSheetOpen(false)}>
          <div className="box">
            <h2>Settings</h2>

            <h3>Mode</h3>
            <div className="modes">
              {MODES.map((m) => (
                <button key={m.id} className={"mode" + (settings.mode === m.id ? " on" : "")} onClick={() => updateSettings({ mode: m.id })}>
                  <span className="radio" />
                  <b>{m.label}</b>
                  <span>{m.help}</span>
                </button>
              ))}
            </div>

            <h3>Steering sensitivity</h3>
            <Range label="Steering range" min={10} max={90} step={1} value={settings.range} fmt={(v) => v + "°"} onChange={(range) => updateSettings({ range })} />
            <Range label="Response curve" min={0.5} max={2.5} step={0.1} value={settings.curve} fmt={(v) => v.toFixed(1)} onChange={(curve) => updateSettings({ curve })} />
            <Range label="Dead zone" min={0} max={10} step={0.5} value={settings.dead} fmt={(v) => v + "°"} onChange={(dead) => updateSettings({ dead })} />
            <Range label="Smoothing" min={0} max={0.9} step={0.05} value={settings.smooth} fmt={(v) => Math.round(v * 100) + "%"} onChange={(smooth) => updateSettings({ smooth })} />
            <p className="note">
              Steering range is how far you tilt for full lock: lower is more sensitive. A response curve above 1.0 gives finer control near the centre.
            </p>
            <label className="toggle">
              Use gyroscope (faster, steadier steering)
              <input type="checkbox" checked={settings.fusion} onChange={(e) => updateSettings({ fusion: e.target.checked })} />
            </label>
            <label className="toggle">
              Reverse steering direction
              <input type="checkbox" checked={settings.invert} onChange={(e) => updateSettings({ invert: e.target.checked })} />
            </label>

            <h3>Pedals</h3>
            <label className="toggle">
              Slide for partial pressure
              <input type="checkbox" checked={settings.analog} onChange={(e) => updateSettings({ analog: e.target.checked })} />
            </label>
            <Range label="Lightest press" min={0} max={0.6} step={0.05} value={settings.pedalMin} fmt={(v) => Math.round(v * 100) + "%"} onChange={(pedalMin) => updateSettings({ pedalMin })} />
            <label className="toggle">
              Vibrate on press (Android)
              <input type="checkbox" checked={settings.vibrate} onChange={(e) => updateSettings({ vibrate: e.target.checked })} />
            </label>

            <div className="sheetActions">
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="ghost" onClick={() => updateSettings({ ...DEFAULTS, mode: settings.mode })}>
                  Reset
                </button>
                <button className="ghost" onClick={changePc}>
                  Change PC
                </button>
              </div>
              <button className="go" onClick={() => setSheetOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Range(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="row">
      {props.label}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <output>{props.fmt(props.value)}</output>
    </label>
  );
}
