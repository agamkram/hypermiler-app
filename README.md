# HyperMiler

Phone-as-gauge for smoother driving. Live accel / brake / corner g-forces, GPS speed, and a trip smoothness score.

**Mount:** fixed, portrait, screen toward cabin. Tap **Start** once — no manual zeroing.

## Stack

Static HTML/JS PWA · shared `fit-to-screen.js` · DeviceMotion + Geolocation · Screen Wake Lock

## Local

Open `index.html` over HTTPS or localhost (sensors require a secure context).

## Icons

```bash
python3 scripts/generate-icons.py
```
