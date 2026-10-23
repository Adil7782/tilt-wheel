Tilt Wheel bridge
=================

This little app turns phones connected to the Tilt Wheel website into
virtual Xbox 360 controllers on this Windows PC.

Setup (once)
  1. Install Python 3.10+ from python.org (tick "Add Python to PATH").
  2. Double-click Start.bat. The first run installs packages; when the
     ViGEmBus driver installer pops up, accept it. Restart if it asks.

Every time
  1. Double-click Start.bat and leave the window open.
  2. Open the Tilt Wheel website in Chrome or Edge on this PC.
  3. Scan its QR code with your phone, tap Start, hold it like a wheel.

The mode (Sim Racing, Sim Racing reversed pedals, Gamepad) is picked in the
app - Sim Racing is the default. The bridge only listens on 127.0.0.1, so
no firewall rule or certificate is needed.

Using your own domain instead of *.vercel.app? Start it like this:
  Start.bat --allow-origin https://wheel.example.com
