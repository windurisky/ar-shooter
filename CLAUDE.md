# CLAUDE.md

## Project Overview

AR Shooter is a browser-based shooting game controlled by hand gestures. Players form a pistol shape with their hand, aim by pointing, and shoot by flicking their thumb. Supports dual-hand (dual wield) tracking.

## Tech Stack

- **Vanilla JS** — no frameworks, no build tools, no bundler
- **MediaPipe Hands** — real-time hand landmark detection (loaded via CDN)
- **Canvas API** — game rendering (targets, crosshair, particles)
- **Three.js** — 3D gun overlay rendering (loaded via CDN)
- All dependencies are loaded via CDN `<script>` tags in `index.html`

## Project Structure

```
index.html          — Game shell, HUD, start/end screens, script loading
style.css           — Neon cyberpunk theme, all styling
app.js              — Entry point, wires HandTracker + Game, manages UI state
game.js             — Game engine: targets, scoring, ammo, timer, rendering
hand-tracking.js    — MediaPipe integration, gesture detection, aim smoothing
gun-renderer.js     — Three.js 3D gun overlay
renderer.js         — Canvas rendering helpers
particle-system.js  — Hit explosion particle effects
event-emitter.js    — Simple pub/sub event system used by Game
assets/             — Audio files (BGM, gun-shot, gun-reload)
```

## Running Locally

```bash
python3 -m http.server 8082
# or: npx serve .
```

Open `http://localhost:8082` in Chrome/Edge. Camera access requires localhost or HTTPS.

## Architecture Notes

- All JS uses IIFEs — no ES modules, no imports/exports
- Classes are defined as globals: `HandTracker`, `Game`, `GunRenderer`, `ParticleSystem`, `Renderer`, `EventEmitter`
- Script load order in `index.html` matters (dependencies must load before dependents)
- Hand IDs are `"Left"` and `"Right"` (MediaPipe labels, mirrored — "Left" = user's right hand)
- Game communicates via `EventEmitter` events: `score`, `time`, `combo`, `ammo`, `reloadStart`, `reloadEnd`, `hit`, `gameOver`

## Testing

No automated tests. Test manually in browser with webcam or use mouse fallback:
- Mouse move = aim, Click = shoot, Space = shoot both, R = reload, C = calibration panel
