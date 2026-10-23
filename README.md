# Tilt Wheel (PWA)

Turn your phone into a gyro steering wheel for PC racing games. Games see it as an Xbox 360 controller.

```
Phone (/play, gyro + tilt) ──WebRTC──▶ PC browser tab (/ , shows QR) ──ws://127.0.0.1:8765──▶ bridge.py (ViGEmBus) ──▶ game
```

- **`/`**: the PC page. Shows a QR code and a 6-letter code, lists the connected phones, and sets the mode for all of them.
- **`/play`**: the phone controller. You can install it as a PWA (it opens in landscape, full screen, and remembers the last PC).
- **`bridge/`**: a small Windows app. A web page can't create a game controller by itself, so this app turns each phone into a virtual Xbox 360 pad. It only listens on `127.0.0.1`, so it needs no certificate or firewall rule. The PC page offers it as a download (`public/TiltWheelBridge.zip`).

Phones pair with the PC through the free PeerJS cloud server. After pairing, the controller data goes straight from the phone to the PC over WebRTC (on the same Wi-Fi it stays on your network).

## Modes

| Mode | Gas | Brake | Use for |
|---|---|---|---|
| **Sim Racing** (default) | right stick Y | right stick X | ACC, Assetto Corsa, rFactor 2 (Wheel controls) |
| Sim Racing, reversed pedals | right stick Y, flipped | right stick X, flipped | if a pedal reads 100% when released |
| Gamepad | RT | LT | Forza, NFS, GTA… |

You can change the mode on each phone (Settings) or for every phone at once on the PC page.
These replace the old `Start.bat`, `Start_SimRacing.bat` and `Start_SimRacing_ReversedPedals.bat` files.

## Phone settings

- **Steering range**: how far you tilt for full lock. Lower is more sensitive.
- **Response curve**: 1.0 is linear. Higher values give finer control near the centre.
- **Dead zone** and **Smoothing**.
- **Use gyroscope**: blends the gyroscope with gravity tilt (a complementary filter), so steering is faster and steadier without drifting.
- Reverse steering, analog pedals, lightest pedal press, vibration.

## Deploy to Vercel

1. Push this folder to a GitHub repo (or run `npx vercel` in it).
2. Import the repo in Vercel. The framework is detected as Next.js and needs no settings.
3. Open `https://<your-app>.vercel.app` on the PC.

Using a custom domain? The bridge accepts `*.vercel.app` and `localhost` by default. For your own domain, start it with
`Start.bat --allow-origin https://wheel.example.com`.

Optional: to use your own PeerJS server, set `NEXT_PUBLIC_PEER_HOST` (plus `NEXT_PUBLIC_PEER_PORT` / `NEXT_PUBLIC_PEER_PATH`).

## Play

1. PC: run `bridge/Start.bat` (one time: install Python 3.10+ and accept the ViGEmBus driver installer).
2. PC: open the site in Chrome or Edge. The "Bridge app" dot turns green. If Chrome asks to allow access to apps on this device, click Allow.
3. Phone: scan the QR code, turn the phone sideways, tap **Start**, and allow motion access.
4. Hold the phone like a wheel and tap **Centre wheel**.

Keep the PC tab open (it can sit behind the game). Several phones can join, and each one becomes its own controller.

## Develop

```
npm install
npm run dev          # http://localhost:3000
npm run zip-bridge   # rebuild public/TiltWheelBridge.zip after editing bridge/
```

Phones need HTTPS to read motion sensors. To test on a phone, use the Vercel deployment (or `next dev --experimental-https`).
