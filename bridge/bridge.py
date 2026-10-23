"""
Tilt Wheel bridge - turns phones connected to the Tilt Wheel web page into
virtual Xbox 360 controllers on this Windows PC.

Open the Tilt Wheel website in a browser on this PC and scan its QR code with
your phone. The page passes each phone's input to this app on
ws://127.0.0.1:8765, which only accepts connections from this PC.

  Steering tilt  -> left stick X
  Gas pedal      -> right trigger (RT)   | Sim mode: right stick Y
  Brake pedal    -> left trigger (LT)    | Sim mode: right stick X
  Buttons        -> A, B, X, Y, LB, RB, Start, Back

The phone picks the mode (Sim Racing is the default). Optional overrides:
  --sim              force sim racing mode for every phone
  --reverse-pedals   force reversed pedal axes
  --allow-origin X   also accept the web page from origin X (custom domain)
"""

import asyncio
import json
import sys
from urllib.parse import urlparse

from aiohttp import WSMsgType, web

try:
    import vgamepad as vg
except Exception as exc:  # driver missing or not on Windows
    print("\nCould not load the virtual controller driver (vgamepad / ViGEmBus).")
    print("Fix: run  pip install vgamepad  and accept the ViGEmBus installer,")
    print("or install ViGEmBus manually from https://github.com/nefarius/ViGEmBus/releases\n")
    print("Details:", exc)
    input("Press Enter to exit...")
    sys.exit(1)

HOST = "127.0.0.1"
PORT = 8765
VERSION = "2.0"
FORCE_SIM = "--sim" in sys.argv
FORCE_REVERSE = "--reverse-pedals" in sys.argv
STALE_AFTER = 1.0  # seconds without input before the pedals are released

EXTRA_ORIGINS = {
    sys.argv[i + 1].rstrip("/").lower()
    for i, a in enumerate(sys.argv[:-1])
    if a == "--allow-origin"
}

# bit sent by the phone -> Xbox button
BUTTONS = [
    (1, vg.XUSB_BUTTON.XUSB_GAMEPAD_A),
    (2, vg.XUSB_BUTTON.XUSB_GAMEPAD_B),
    (4, vg.XUSB_BUTTON.XUSB_GAMEPAD_X),
    (8, vg.XUSB_BUTTON.XUSB_GAMEPAD_Y),
    (16, vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER),
    (32, vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER),
    (64, vg.XUSB_BUTTON.XUSB_GAMEPAD_START),
    (128, vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK),
]


def origin_allowed(origin: str) -> bool:
    """Only the Tilt Wheel page may drive the controllers, not any random website."""
    if not origin:
        return True  # not a browser
    origin = origin.rstrip("/").lower()
    if origin in EXTRA_ORIGINS:
        return True
    host = urlparse(origin).hostname or ""
    return host in ("localhost", "127.0.0.1") or host.endswith(".vercel.app")


def clamp(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return lo if v < lo else hi if v > hi else v


async def status_handler(request):
    """The web page keeps this open to show whether the bridge is running."""
    if not origin_allowed(request.headers.get("Origin", "")):
        print(f"  ! Refused page from {request.headers.get('Origin')} (start with --allow-origin to permit it)")
        raise web.HTTPForbidden()
    ws = web.WebSocketResponse(heartbeat=5)
    await ws.prepare(request)
    await ws.send_json({"type": "hello", "version": VERSION})
    async for _ in ws:
        pass
    return ws


async def pad_handler(request):
    if not origin_allowed(request.headers.get("Origin", "")):
        raise web.HTTPForbidden()
    ws = web.WebSocketResponse(heartbeat=5)
    await ws.prepare(request)

    player = request.query.get("player", "?")
    pad = vg.VX360Gamepad()
    print(f"  + Controller {player} connected")

    flags = 0
    first = True

    def pedals_at_rest():
        # sim mode keeps the pedal axes at their "released" end, never the middle
        if flags & 1:
            rest = 1.0 if flags & 2 else -1.0
            pad.right_joystick_float(x_value_float=rest, y_value_float=rest)
        else:
            pad.right_joystick_float(x_value_float=0.0, y_value_float=0.0)
        pad.left_trigger_float(value_float=0.0)
        pad.right_trigger_float(value_float=0.0)

    try:
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=STALE_AFTER)
            except asyncio.TimeoutError:
                # phone went quiet (locked screen, Wi-Fi hiccup): never leave the car on throttle
                pad.reset()
                pedals_at_rest()
                pad.update()
                continue
            if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
                steer, gas, brake, bits = data[:4]
                bits = int(bits)
                new_flags = int(data[4]) if len(data) > 4 else 0
            except (ValueError, TypeError, IndexError, KeyError):
                continue
            if FORCE_SIM:
                new_flags |= 1
            if FORCE_REVERSE:
                new_flags |= 2
            if new_flags != flags or first:
                mode = "SIM RACING (gas = right stick Y, brake = right stick X)" if new_flags & 1 else "GAMEPAD (gas = RT, brake = LT)"
                rev = ", pedals reversed" if new_flags & 2 else ""
                print(f"    Controller {player} mode: {mode}{rev}")
                first = False
            flags = new_flags

            gas = clamp(gas, 0, 1)
            brake = clamp(brake, 0, 1)
            pad.left_joystick_float(x_value_float=clamp(steer, -1, 1), y_value_float=0.0)

            if flags & 1:
                # Sim mode: gas on right stick Y, brake on right stick X,
                # so each pedal is its own axis in wheel-mode games (ACC, AC, rFactor...)
                g, b = gas * 2 - 1, brake * 2 - 1
                if flags & 2:
                    g, b = -g, -b
                pad.right_joystick_float(x_value_float=b, y_value_float=g)
                pad.right_trigger_float(value_float=0.0)
                pad.left_trigger_float(value_float=0.0)
            else:
                pad.right_joystick_float(x_value_float=0.0, y_value_float=0.0)
                pad.right_trigger_float(value_float=gas)
                pad.left_trigger_float(value_float=brake)

            for bit, button in BUTTONS:
                if bits & bit:
                    pad.press_button(button=button)
                else:
                    pad.release_button(button=button)
            pad.update()
    finally:
        pad.reset()
        pedals_at_rest()
        pad.update()
        del pad
        print(f"  - Controller {player} disconnected")
    return ws


async def index(request):
    return web.Response(text=f"Tilt Wheel bridge {VERSION} is running. Open the Tilt Wheel website on this PC.")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/status", status_handler)
    app.router.add_get("/pad", pad_handler)

    print("\n==============================================")
    print(f"  Tilt Wheel bridge {VERSION} is running")
    if FORCE_SIM:
        print("  Sim racing mode forced ON for every phone")
    if FORCE_REVERSE:
        print("  Reversed pedals forced ON for every phone")
    print("==============================================\n")
    print("  1. Open the Tilt Wheel website in Chrome or Edge on this PC.")
    print("  2. Scan the QR code it shows with your phone.\n")
    print("  Leave this window open while you play. Press Ctrl+C to stop.\n")

    try:
        web.run_app(app, host=HOST, port=PORT, print=None)
    except OSError:
        print(f"Port {PORT} is busy - is the bridge already running in another window?")
        input("Press Enter to exit...")


if __name__ == "__main__":
    main()
