# 🔫 AR Shooter — Hand Gesture Tracking Game

A browser-based shooter game controlled entirely by your hand. Point your finger like a **pistol**, aim at targets, and flick your thumb to shoot — no controllers needed.

![Tech](https://img.shields.io/badge/MediaPipe-Hands-blue) ![Tech](https://img.shields.io/badge/Canvas-API-purple) ![Tech](https://img.shields.io/badge/Vanilla-JS-yellow)

---

## 🚀 Quick Start

```bash
# Clone or navigate to the project folder
cd ar-shooter

# Start a local server (any of these work)
python3 -m http.server 8080
# or: npx serve .
# or: npx http-server .
```

Then open **http://localhost:8080** in Chrome or Edge.

> ⚠️ **Must run on localhost or HTTPS** — camera access requires a secure context.

---

## 🕹️ How to Play

### Pistol Gesture
Hold your hand so that:
- ☝️ **Index finger** is extended (pointing forward)
- 👍 **Thumb** is up
- ✊ **Middle, ring, pinky** fingers are curled in

The gesture indicator at the bottom turns **green** when detected.

### Aiming
Move your **index fingertip** around — the cyan crosshair follows it.

### Shooting
**Flick your thumb downward** quickly (like cocking a hammer) to fire.

### Mouse Fallback *(for testing without camera)*
- **Move mouse** → aims the crosshair
- **Click** → shoots
- **Space** → shoots
- **R** → reloads

---

## 🎮 Game Features

| Feature | Details |
|---|---|
| **Targets** | Circle & diamond types, move & bounce around the screen |
| **Scoring** | Base 100pts + accuracy bonus + combo multiplier (up to ×5) |
| **Combo** | Consecutive hits increase multiplier |
| **Ammo** | 6 rounds, auto-reloads when empty (1.5s) |
| **Timer** | 60 second rounds |
| **Particles** | Explosion effects on hit |
| **Muzzle Flash** | Visual feedback on every shot |

---

## 🧰 Tech Stack

| Technology | Role |
|---|---|
| [MediaPipe Hands](https://google.github.io/mediapipe/solutions/hands) | Real-time hand landmark detection (21 keypoints, ~30fps) |
| Canvas API | Game rendering — background, targets, crosshair, particles |
| `getUserMedia` | Webcam access for hand tracking |
| Vanilla HTML/CSS/JS | No build tools or frameworks required |

---

## 📁 Project Structure

```
ar-shooter/
├── index.html        # Game shell, HUD, start/end screens
├── style.css         # Neon cyberpunk theme, animations
├── hand-tracking.js  # MediaPipe integration, gesture detection
├── game.js           # Game engine — targets, scoring, rendering
└── app.js            # Wires everything together, manages UI states
```

---

## 🛠️ Gesture Detection Details

Hand tracking uses **MediaPipe Hands** with 21 landmark points. The pistol gesture is detected by checking:

- **Index finger extended** — tip is farther from MCP joint than pip joint
- **Middle / Ring / Pinky curled** — tips closer to MCP than PIP
- **Thumb extended** — tip is away from its MCP joint

**Shoot trigger:** The thumb tip is tracked over 8 frames. A rapid downward motion (`dy > 0.03` in normalized coords, within 300ms) fires a shot, with a 400ms cooldown to prevent rapid-fire spam.

**Aim smoothing:** Index fingertip position is exponentially smoothed (`factor = 0.35`) to prevent jittery crosshair movement.

---

## 🌐 Browser Compatibility

| Browser | Status |
|---|---|
| Chrome 90+ | ✅ Recommended |
| Edge 90+ | ✅ Supported |
| Firefox | ⚠️ May have MediaPipe WASM issues |
| Safari | ❌ Not supported (WebAssembly restrictions) |

---

## 📄 License

MIT — free to use and modify.
