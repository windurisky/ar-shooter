/**
 * Hand Tracking Module
 * Uses MediaPipe Hands to detect pistol gesture, aim direction, and shoot trigger.
 *
 * Pistol Gesture: Index finger extended, thumb up, middle/ring/pinky curled.
 * Aim: Ray cast from index knuckle → tip, extrapolated forward by rayExtend to
 *      compensate for camera being above the screen plane.
 * Shoot: Thumb tip (landmark 4) rapid downward flick relative to thumb MCP (landmark 2).
 *
 * ── CALIBRATION ────────────────────────────────────────────────────────────────
 * rayExtend      — How far past the fingertip to project the aiming ray.
 *                  Increase if crosshair lags behind real finger target (camera high up).
 *                  Default: 1.8  Range: 1.0 (no extension) → 3.0 (very extended)
 *
 * sensitivity    — Stretches the active hand zone to fill the full screen.
 *                  Increase if you can't reach screen edges.
 *                  Default: 1.6  Range: 1.0 (no scaling) → 3.0 (very sensitive)
 *
 * aimOriginX/Y  — The center point in camera-space that maps to screen center.
 *                  0.5/0.5 = literal camera center.
 *                  Nudge aimOriginY up (e.g. 0.4) if crosshair consistently too low.
 * ────────────────────────────────────────────────────────────────────────────────
 */

class HandTracker {
    constructor() {
        this.hands = null;
        this.camera = null;
        this.videoElement = null;

        // ── Calibration ──────────────────────────────────────────────
        // Ray extension: projects aim ray past the fingertip.
        // Compensates for camera being above the screen (top-center mount).
        // Increase if crosshair is always below where you're pointing.
        this.rayExtend = 1.8;

        // Sensitivity: scales hand movement range to fill the full screen.
        // Increase if you can't reach the screen edges.
        this.sensitivity = 1.6;

        // The camera-space point that maps to screen center (0–1 range).
        // Default assumes camera is centered horizontally (0.5)
        // and slightly above mid-frame vertically (0.4) for top-mounted webcam.
        this.aimOriginX = 0.5;
        this.aimOriginY = 0.4;
        // ─────────────────────────────────────────────────────────────

        // State
        this.isTracking = false;
        this.isPistolGesture = false;
        this.aimX = 0.5;
        this.aimY = 0.5;
        this.smoothAimX = 0.5;
        this.smoothAimY = 0.5;
        this.landmarks = null;

        // Shoot detection
        this.thumbHistory = [];
        this.thumbHistoryMax = 8;
        this.shootCooldown = false;
        this.shootCooldownMs = 400;

        // Smoothing (lower = smoother but more lag, higher = more responsive)
        this.smoothingFactor = 0.3;

        // Callbacks
        this.onAimUpdate = null;
        this.onShoot = null;
        this.onGestureChange = null;
        this.onTrackingReady = null;
    }

    async init(videoElement) {
        this.videoElement = videoElement;

        this.hands = new Hands({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`;
            }
        });

        this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.6,
        });

        this.hands.onResults((results) => this._onResults(results));

        this.camera = new Camera(this.videoElement, {
            onFrame: async () => {
                await this.hands.send({ image: this.videoElement });
            },
            width: 1280,
            height: 720,
        });

        await this.camera.start();
        this.isTracking = true;
        if (this.onTrackingReady) this.onTrackingReady();
    }

    _onResults(results) {
        // Store raw results for canvas drawing
        this.lastResults = results;

        if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
            if (this.isPistolGesture) {
                this.isPistolGesture = false;
                if (this.onGestureChange) this.onGestureChange(false);
            }
            return;
        }

        const landmarks = results.multiHandLandmarks[0];
        this.landmarks = landmarks;

        // Check pistol gesture
        const wasPistol = this.isPistolGesture;
        this.isPistolGesture = this._detectPistolGesture(landmarks);

        if (this.isPistolGesture !== wasPistol) {
            if (this.onGestureChange) this.onGestureChange(this.isPistolGesture);
        }

        if (this.isPistolGesture) {
            // ── Ray casting aim ──────────────────────────────────────────────
            // Use the direction from index MCP (knuckle, lm[5]) → tip (lm[8])
            // and project the ray forward by `rayExtend` past the tip.
            // This compensates for the camera being above the screen:
            // the finger points slightly downward toward the screen, so
            // extending the ray brings the aim point to where the finger is touching.
            const mcp = landmarks[5];  // index finger knuckle (base)
            const tip = landmarks[8];  // index finger tip

            // Direction vector from knuckle to tip (in normalized camera space)
            const dx = tip.x - mcp.x;
            const dy = tip.y - mcp.y;

            // Projected aim point: extend past the tip by rayExtend factor
            // Mirror X since camera is horizontally flipped
            const rawX = 1.0 - (tip.x + dx * this.rayExtend);
            const rawY = tip.y + dy * this.rayExtend;

            // ── Sensitivity scaling ──────────────────────────────────────────
            // Remap from camera-space (centered at aimOrigin) to [0,1] screen space.
            // sensitivity > 1 stretches hand movement to fill screen edges.
            this.aimX = (rawX - this.aimOriginX) * this.sensitivity + 0.5;
            this.aimY = (rawY - this.aimOriginY) * this.sensitivity + 0.5;

            // Clamp to valid screen range
            this.aimX = Math.max(0, Math.min(1, this.aimX));
            this.aimY = Math.max(0, Math.min(1, this.aimY));

            // Smooth aim
            this.smoothAimX += (this.aimX - this.smoothAimX) * this.smoothingFactor;
            this.smoothAimY += (this.aimY - this.smoothAimY) * this.smoothingFactor;

            if (this.onAimUpdate) {
                this.onAimUpdate(this.smoothAimX, this.smoothAimY);
            }

            // Check for shoot gesture
            this._detectShoot(landmarks);
        }
    }

    _detectPistolGesture(lm) {
        // Landmarks reference:
        // 0: wrist, 4: thumb tip, 8: index tip, 12: middle tip, 16: ring tip, 20: pinky tip
        // MCP joints: 2(thumb), 5(index), 9(middle), 13(ring), 17(pinky)
        // PIP joints: 3(thumb), 6(index), 10(middle), 14(ring), 18(pinky)

        // Index finger: should be extended (tip above PIP relative to wrist)
        const indexExtended = this._isFingerExtended(lm, 5, 6, 7, 8);

        // Middle finger: should be curled
        const middleCurled = !this._isFingerExtended(lm, 9, 10, 11, 12);

        // Ring finger: should be curled
        const ringCurled = !this._isFingerExtended(lm, 13, 14, 15, 16);

        // Pinky: should be curled
        const pinkyCurled = !this._isFingerExtended(lm, 17, 18, 19, 20);

        // Thumb: more relaxed — can be up or slightly to the side
        // We just check it's not fully curled against the palm
        const thumbUp = this._isThumbExtended(lm);

        return indexExtended && middleCurled && ringCurled && pinkyCurled && thumbUp;
    }

    _isFingerExtended(lm, mcpIdx, pipIdx, dipIdx, tipIdx) {
        // A finger is "extended" if the tip is farther from wrist than the PIP joint
        const wrist = lm[0];
        const mcp = lm[mcpIdx];
        const pip = lm[pipIdx];
        const tip = lm[tipIdx];

        const tipDist = this._dist3D(tip, mcp);
        const pipDist = this._dist3D(pip, mcp);

        return tipDist > pipDist * 1.2;
    }

    _isThumbExtended(lm) {
        const thumbTip = lm[4];
        const thumbIP = lm[3];
        const thumbMCP = lm[2];

        const tipDist = this._dist3D(thumbTip, thumbMCP);
        const ipDist = this._dist3D(thumbIP, thumbMCP);

        return tipDist > ipDist * 0.9;
    }

    _dist3D(a, b) {
        return Math.sqrt(
            (a.x - b.x) ** 2 +
            (a.y - b.y) ** 2 +
            (a.z - b.z) ** 2
        );
    }

    _detectShoot(lm) {
        if (this.shootCooldown) return;

        const thumbTip = lm[4];
        const thumbMCP = lm[2];
        const indexMCP = lm[5];

        // Track the angle of thumb relative to index MCP
        // When the thumb "flicks" down, this angle changes rapidly
        const thumbAngle = Math.atan2(thumbTip.y - thumbMCP.y, thumbTip.x - thumbMCP.x);

        this.thumbHistory.push({
            angle: thumbAngle,
            y: thumbTip.y,
            time: Date.now()
        });

        if (this.thumbHistory.length > this.thumbHistoryMax) {
            this.thumbHistory.shift();
        }

        if (this.thumbHistory.length >= 3) {
            const recent = this.thumbHistory.slice(-3);
            const dy = recent[2].y - recent[0].y;
            const dt = recent[2].time - recent[0].time;

            // Thumb moved downward quickly (y increases downward in screen coords)
            if (dy > 0.03 && dt < 300) {
                this._triggerShoot();
            }
        }
    }

    _triggerShoot() {
        this.shootCooldown = true;
        this.thumbHistory = [];

        if (this.onShoot) this.onShoot();

        setTimeout(() => {
            this.shootCooldown = false;
        }, this.shootCooldownMs);
    }

    destroy() {
        if (this.camera) {
            this.camera.stop();
        }
        this.isTracking = false;
    }
}
