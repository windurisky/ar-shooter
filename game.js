/**
 * Game Engine — Targets, scoring, game loop.
 * Supports dual-hand weapons with independent aim, ammo, and reload per hand.
 * Emits events: score, time, combo, ammo, reloadStart, reloadEnd, gameOver, hit.
 *
 * Targets are 3D plank boards rendered by RangeRenderer; this class manages
 * their logical state and reads screen-projected coords for hit detection.
 */
class Game extends EventEmitter {
    // Per-frame crosshair interpolation speed (0–1, higher = snappier)
    static AIM_LERP = 0.25;

    // Max concurrent targets per lane (index matches RangeRenderer.LANES order)
    static MAX_PER_LANE = [1, 1, 1];

    constructor(canvas, rangeRenderer) {
        super();
        this.renderer = new Renderer(canvas);
        this.rangeRenderer = rangeRenderer || null;
        this.particleSystem = new ParticleSystem();
        this.isRunning = false;
        this.score = 0; this.combo = 0; this.maxCombo = 0;
        this.totalShots = 0; this.totalHits = 0;
        this.timeLeft = 60; this.timerInterval = null;
        this.maxAmmo = 6; this.reloadTime = 1500;
        this.muzzleFlashAlpha = 0;

        // Dual weapon system — keyed by hand label ("Left"/"Right")
        this.weapons = {
            Left: this._createWeapon(),
            Right: this._createWeapon(),
        };

        this.targets = [];
        this._nextTargetId = 0;
        this.targetMinSpawnMs = 800; this.targetMaxSpawnMs = 1800;

        this._gameLoop = this._gameLoop.bind(this);
        this._handleResize = () => this.renderer.resize();
        window.addEventListener('resize', this._handleResize);
    }

    get width()  { return this.renderer.width;  }
    get height() { return this.renderer.height; }

    _createWeapon() {
        return {
            crosshairX: this.renderer.width  / 2,
            crosshairY: this.renderer.height / 2,
            targetX:    this.renderer.width  / 2,
            targetY:    this.renderer.height / 2,
            showCrosshair: false,
            ammo: this.maxAmmo,
            isReloading: false,
            reloadTimer: null,
        };
    }

    start() {
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        if (this._animFrameId)   cancelAnimationFrame(this._animFrameId);
        clearInterval(this.timerInterval);

        this.score = 0; this.combo = 0; this.maxCombo = 0;
        this.totalShots = 0; this.totalHits = 0;
        this.timeLeft = 60;

        for (const id of Object.keys(this.weapons)) {
            const w = this.weapons[id];
            w.ammo = this.maxAmmo;
            w.isReloading = false;
            w.showCrosshair = false;
            if (w.reloadTimer) clearTimeout(w.reloadTimer);
            w.reloadTimer = null;
        }

        // Remove any leftover target meshes
        if (this.rangeRenderer) {
            for (const t of this.targets) this.rangeRenderer.removeTarget(t);
        }
        this.targets = [];
        this._nextTargetId = 0;

        this.particleSystem.clear();
        this.isRunning = true;

        this.timerInterval = setInterval(() => {
            this.timeLeft--;
            this.emit('time', this.timeLeft);
            if (this.timeLeft <= 0) this.stop();
        }, 1000);

        this._scheduleNextTarget();
        this._animFrameId = requestAnimationFrame(this._gameLoop);
    }

    pause() {
        if (!this.isRunning) return;
        this.isPaused = true;
        clearInterval(this.timerInterval);
        if (this._animFrameId)   cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
    }

    resume() {
        if (!this.isRunning || !this.isPaused) return;
        this.isPaused = false;
        this.timerInterval = setInterval(() => {
            this.timeLeft--;
            this.emit('time', this.timeLeft);
            if (this.timeLeft <= 0) this.stop();
        }, 1000);
        this._scheduleNextTarget();
        this._animFrameId = requestAnimationFrame(this._gameLoop);
    }

    stop() {
        this.isRunning = false;
        this.isPaused  = false;
        clearInterval(this.timerInterval);
        if (this._animFrameId)   cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        for (const w of Object.values(this.weapons)) {
            if (w.reloadTimer) clearTimeout(w.reloadTimer);
        }
        this.emit('gameOver', {
            score:    this.score,
            hits:     this.totalHits,
            shots:    this.totalShots,
            accuracy: this.totalShots > 0 ? Math.round((this.totalHits / this.totalShots) * 100) : 0,
            maxCombo: this.maxCombo,
        });
    }

    updateAim(handId, normX, normY) {
        const w = this.weapons[handId];
        if (!w) return;
        w.targetX = normX * this.width;
        w.targetY = normY * this.height;
        w.showCrosshair = true;
    }

    hideCrosshair(handId) {
        const w = this.weapons[handId];
        if (w) w.showCrosshair = false;
    }

    shoot(handId) {
        if (!this.isRunning) return;
        const w = this.weapons[handId];
        if (!w || w.isReloading) return;
        if (w.ammo <= 0) { this._startReload(handId); return; }

        w.ammo--;
        this.totalShots++;
        this.muzzleFlashAlpha = 1.0;
        this.emit('ammo', handId, w.ammo, this.maxAmmo);

        let hit = false;

        // Hit detection in screen space — RangeRenderer writes screenX/Y/Radius each frame
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            // Only hittable while idle (already fully risen)
            if (t.state !== 'idle') continue;
            if (t.screenRadius === undefined) continue;

            const dist = Math.sqrt((w.crosshairX - t.screenX) ** 2 + (w.crosshairY - t.screenY) ** 2);
            if (dist > t.screenRadius) continue;

            hit = true;
            t.state = 'falling';
            t.stateStart = Date.now();

            const kindCfg = RangeRenderer.KINDS[t.kind];

            if (kindCfg.hostage) {
                // Hostage hit: penalty
                this.score = Math.max(0, this.score - 100);
                this.combo  = 0;
                this.particleSystem.spawnExplosion(t.screenX, t.screenY, '#ff4466');
                this.emit('hit', t.screenX, t.screenY, '-100', 'penalty');
                this.emit('score', this.score);
                this.emit('combo', this.combo);
                if (this.rangeRenderer) this.rangeRenderer.nudge();
            } else {
                // Enemy hit: score
                this.totalHits++;
                this.combo++;
                if (this.combo > this.maxCombo) this.maxCombo = this.combo;
                const pts = this._calcPoints(t);
                this.score += pts;
                this.particleSystem.spawnExplosion(t.screenX, t.screenY, '#ff8800');
                this.emit('hit', t.screenX, t.screenY, `+${pts}`, false);
                this.emit('score', this.score);
                this.emit('combo', this.combo);
            }
            break;
        }

        if (!hit) {
            this.combo = 0;
            this.emit('combo', this.combo);
            this.emit('hit', w.crosshairX, w.crosshairY - 20, 'MISS', true);
        }

        if (w.ammo <= 0) setTimeout(() => this._startReload(handId), 300);
    }

    reload(handId) {
        if (!this.isRunning) return;
        this._startReload(handId);
    }

    // ─── Private ────────────────────────────────────────────────────────────────

    _calcPoints(t) {
        // Base from kind, multiplied by combo
        const kindCfg = RangeRenderer.KINDS[t.kind];
        const mult = Math.min(1 + this.combo * 0.5, 5);
        return Math.floor(kindCfg.basePoints * mult);
    }

    _startReload(handId) {
        const w = this.weapons[handId];
        if (!w || w.isReloading) return;
        w.isReloading = true;
        this.emit('reloadStart', handId, this.reloadTime);
        w.reloadTimer = setTimeout(() => {
            w.ammo = this.maxAmmo; w.isReloading = false; w.reloadTimer = null;
            this.emit('ammo', handId, w.ammo, this.maxAmmo);
            this.emit('reloadEnd', handId);
        }, this.reloadTime);
    }

    _scheduleNextTarget() {
        if (!this.isRunning) return;
        const delay = this.targetMinSpawnMs + Math.random() * (this.targetMaxSpawnMs - this.targetMinSpawnMs);
        this._targetTimeout = setTimeout(() => {
            this._spawnTarget();
            this._scheduleNextTarget();
        }, delay);
    }

    _spawnTarget() {
        const LANES = RangeRenderer.LANES;
        const KINDS = RangeRenderer.KINDS;

        // Count per-lane active targets
        const laneCounts = [0, 0, 0];
        for (const t of this.targets) {
            if (t.state !== 'dead') laneCounts[t.lane]++;
        }

        // Build eligible lanes
        const eligible = LANES.map((lane, idx) => ({
            idx,
            weight: laneCounts[idx] < Game.MAX_PER_LANE[idx] ? lane.weight : 0,
        })).filter(e => e.weight > 0);

        if (eligible.length === 0) return; // all lanes full

        // Weighted random lane pick
        const totalW = eligible.reduce((s, e) => s + e.weight, 0);
        let r = Math.random() * totalW;
        let laneIdx = eligible[0].idx;
        for (const e of eligible) {
            r -= e.weight;
            if (r <= 0) { laneIdx = e.idx; break; }
        }
        const lane = LANES[laneIdx];

        // Determine kind
        let kind;
        if (Math.random() < RangeRenderer.HOSTAGE_RATE) {
            kind = Math.random() < 0.5 ? 'hostageM' : 'hostageF';
        } else {
            // cyborg vs spider by weight
            kind = Math.random() < KINDS.cyborg.weight ? 'cyborg' : 'spider';
        }

        const kindCfg = KINDS[kind];
        const [minSpd, maxSpd] = kindCfg.speedRange;
        const speed = minSpd + Math.random() * (maxSpd - minSpd);
        const vx    = speed * (Math.random() < 0.5 ? 1 : -1);

        // Pick worldX with minimum spacing from other targets in this lane
        const MIN_SPACING = 1.8; // world units
        const MAX_TRIES = 8;
        let worldX = 0;
        let placed = false;
        for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
            const candidate = (Math.random() * 2 - 1) * lane.halfWidth * 0.85;
            let clash = false;
            for (const other of this.targets) {
                if (other.lane !== laneIdx) continue;
                if (other.state === 'dead') continue;
                if (Math.abs(other.worldX - candidate) < MIN_SPACING) {
                    clash = true;
                    break;
                }
            }
            if (!clash) {
                worldX = candidate;
                placed = true;
                break;
            }
        }
        if (!placed) return; // no room this cycle

        const target = {
            id:        this._nextTargetId++,
            kind,
            lane:      laneIdx,
            worldX,
            worldY:    -0.2, // vertical center (chest height)
            worldZ:    lane.z,
            vx,
            laneMinX:  -lane.halfWidth + 0.3,
            laneMaxX:   lane.halfWidth - 0.3,
            born:       Date.now(),
            lifetime:   4000 + Math.random() * 3000,
            state:      'rising',
            stateStart: Date.now(),
            // Set by RangeRenderer.syncTargets each frame:
            screenX: this.width  / 2,
            screenY: this.height / 2,
            screenRadius: 40,
        };

        this.targets.push(target);
        if (this.rangeRenderer) this.rangeRenderer.addTarget(target);
    }

    _updateTargets(now) {
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            const elapsed = now - t.stateStart;

            // State transitions
            if (t.state === 'rising' && elapsed >= RangeRenderer.RISE_MS) {
                t.state = 'idle';
                t.stateStart = now;
            } else if (t.state === 'idle') {
                // Slide horizontally
                t.worldX += t.vx;
                if (t.worldX < t.laneMinX || t.worldX > t.laneMaxX) {
                    t.vx *= -1;
                    t.worldX = Math.max(t.laneMinX, Math.min(t.laneMaxX, t.worldX));
                }
                // Expire
                if (now - t.born > t.lifetime) {
                    t.state = 'falling';
                    t.stateStart = now;
                }
            } else if (t.state === 'falling' && elapsed >= RangeRenderer.FALL_MS) {
                t.state = 'dead';
            }

            // Remove dead targets
            if (t.state === 'dead') {
                if (this.rangeRenderer) this.rangeRenderer.removeTarget(t);
                this.targets.splice(i, 1);
            }
        }

        // Let RangeRenderer project world→screen for hit detection
        if (this.rangeRenderer) this.rangeRenderer.syncTargets(this.targets, now);
    }

    _gameLoop() {
        if (!this.isRunning) return;
        const now = Date.now();

        this.renderer.clear();
        this.renderer.drawBackground(now); // no-op — Three.js handles background

        this._updateTargets(now);
        this.renderer.drawTargets(this.targets, now); // no-op — Three.js handles targets

        this.particleSystem.update();
        this.renderer.drawParticles(this.particleSystem.getParticles());

        // Smoothly interpolate crosshairs toward target
        const lerp = Game.AIM_LERP;
        for (const w of Object.values(this.weapons)) {
            w.crosshairX += (w.targetX - w.crosshairX) * lerp;
            w.crosshairY += (w.targetY - w.crosshairY) * lerp;
        }

        this.renderer.drawCrosshairs(this.weapons, now);

        if (this.muzzleFlashAlpha > 0) {
            this.renderer.drawMuzzleFlash(this.weapons, this.muzzleFlashAlpha);
            this.muzzleFlashAlpha -= 0.08;
        }

        this.renderer.drawScanLines();
        this._animFrameId = requestAnimationFrame(this._gameLoop);
    }

    destroy() {
        this.isRunning = false;
        clearInterval(this.timerInterval);
        if (this._animFrameId)   cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        for (const w of Object.values(this.weapons)) {
            if (w.reloadTimer) clearTimeout(w.reloadTimer);
        }
        window.removeEventListener('resize', this._handleResize);
        this.renderer.destroy();
    }
}
