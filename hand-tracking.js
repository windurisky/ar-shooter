/**
 * Hand Tracking Module
 * Uses MediaPipe Hands to detect pistol gesture, aim direction, and shoot trigger.
 * Supports dual-hand tracking — each hand is tracked independently.
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
        this.rayExtend = 1.8;
        this.sensitivity = 1.6;
        this.aimOriginX = 0.5;
        this.aimOriginY = 0.4;
        // ─────────────────────────────────────────────────────────────

        // State
        this.isTracking = false;

        // Per-hand state keyed by "Left"/"Right"
        this.handState = {};

        // Shoot detection config
        this.thumbHistoryMax = 8;
        this.shootCooldownMs = 400;

        // Smoothing (lower = smoother but more lag, higher = more responsive)
        this.smoothingFactor = 0.3;

        // Callbacks — all now receive handId ("Left"/"Right") as first param
        this.onAimUpdate = null;   // (handId, x, y)
        this.onShoot = null;       // (handId)
        this.onGestureChange = null; // (handId, isPistol)
        this.onTrackingReady = null;
    }

    _getHandState(handId) {
        if (!this.handState[handId]) {
            this.handState[handId] = {
                isPistolGesture: false,
                aimX: 0.5,
                aimY: 0.5,
                smoothAimX: 0.5,
                smoothAimY: 0.5,
                landmarks: null,
                thumbHistory: [],
                shootCooldown: false,
            };
        }
        return this.handState[handId];
    }

    async init(videoElement) {
        this.videoElement = videoElement;

        this.hands = new Hands({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`;
            }
        });

        this.hands.setOptions({
            maxNumHands: 2,
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
        this.lastResults = results;

        // Track which hands are present this frame
        const activeHands = new Set();

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (let i = 0; i < results.multiHandLandmarks.length; i++) {
                const landmarks = results.multiHandLandmarks[i];
                // MediaPipe labels: "Left"/"Right" (from camera's perspective,
                // which is mirrored — so "Left" label = user's right hand)
                const label = results.multiHandedness[i].label;
                activeHands.add(label);

                const state = this._getHandState(label);
                state.landmarks = landmarks;

                const wasPistol = state.isPistolGesture;
                state.isPistolGesture = this._detectPistolGesture(landmarks);

                if (state.isPistolGesture !== wasPistol) {
                    if (this.onGestureChange) this.onGestureChange(label, state.isPistolGesture);
                }

                if (state.isPistolGesture) {
                    this._processAim(label, state, landmarks);
                    this._detectShoot(label, state, landmarks);
                }
            }
        }

        // Clear gesture for hands that disappeared
        for (const handId of Object.keys(this.handState)) {
            if (!activeHands.has(handId) && this.handState[handId].isPistolGesture) {
                this.handState[handId].isPistolGesture = false;
                if (this.onGestureChange) this.onGestureChange(handId, false);
            }
        }
    }

    _processAim(handId, state, landmarks) {
        const mcp = landmarks[5];
        const tip = landmarks[8];

        const dx = tip.x - mcp.x;
        const dy = tip.y - mcp.y;

        // Mirror X since camera is horizontally flipped
        const rawX = 1.0 - (tip.x + dx * this.rayExtend);
        const rawY = tip.y + dy * this.rayExtend;

        state.aimX = (rawX - this.aimOriginX) * this.sensitivity + 0.5;
        state.aimY = (rawY - this.aimOriginY) * this.sensitivity + 0.5;

        state.aimX = Math.max(0, Math.min(1, state.aimX));
        state.aimY = Math.max(0, Math.min(1, state.aimY));

        state.smoothAimX += (state.aimX - state.smoothAimX) * this.smoothingFactor;
        state.smoothAimY += (state.aimY - state.smoothAimY) * this.smoothingFactor;

        if (this.onAimUpdate) {
            this.onAimUpdate(handId, state.smoothAimX, state.smoothAimY);
        }
    }

    _detectPistolGesture(lm) {
        const indexExtended = this._isFingerExtended(lm, 5, 6, 7, 8);
        const middleCurled = !this._isFingerExtended(lm, 9, 10, 11, 12);
        const ringCurled = !this._isFingerExtended(lm, 13, 14, 15, 16);
        const pinkyCurled = !this._isFingerExtended(lm, 17, 18, 19, 20);
        const thumbUp = this._isThumbExtended(lm);

        return indexExtended && middleCurled && ringCurled && pinkyCurled && thumbUp;
    }

    _isFingerExtended(lm, mcpIdx, pipIdx, dipIdx, tipIdx) {
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

    _detectShoot(handId, state, lm) {
        if (state.shootCooldown) return;

        const thumbTip = lm[4];
        const thumbMCP = lm[2];

        const thumbAngle = Math.atan2(thumbTip.y - thumbMCP.y, thumbTip.x - thumbMCP.x);

        state.thumbHistory.push({
            angle: thumbAngle,
            y: thumbTip.y,
            time: Date.now()
        });

        if (state.thumbHistory.length > this.thumbHistoryMax) {
            state.thumbHistory.shift();
        }

        if (state.thumbHistory.length >= 3) {
            const recent = state.thumbHistory.slice(-3);
            const dy = recent[2].y - recent[0].y;
            const dt = recent[2].time - recent[0].time;

            if (dy > 0.03 && dt < 300) {
                this._triggerShoot(handId, state);
            }
        }
    }

    _triggerShoot(handId, state) {
        state.shootCooldown = true;
        state.thumbHistory = [];

        if (this.onShoot) this.onShoot(handId);

        setTimeout(() => {
            state.shootCooldown = false;
        }, this.shootCooldownMs);
    }

    destroy() {
        if (this.camera) {
            this.camera.stop();
        }
        this.isTracking = false;
    }
}
