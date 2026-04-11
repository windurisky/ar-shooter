/**
 * Game Engine — Targets, scoring, game loop.
 * Supports dual-hand weapons with independent aim, ammo, and reload per hand.
 * Emits events: score, time, combo, ammo, reloadStart, reloadEnd, gameOver, hit.
 */
class Game extends EventEmitter {
    // Per-frame crosshair interpolation speed (0–1, higher = snappier)
    static AIM_LERP = 0.25;

    constructor(canvas) {
        super();
        this.renderer = new Renderer(canvas);
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

        this.targets = []; this.maxTargets = 4;
        this.targetMinSpawnMs = 800; this.targetMaxSpawnMs = 2000;

        this._gameLoop = this._gameLoop.bind(this);
        this._handleResize = () => this.renderer.resize();
        window.addEventListener('resize', this._handleResize);
    }

    get width() { return this.renderer.width; }
    get height() { return this.renderer.height; }

    _createWeapon() {
        return {
            crosshairX: this.renderer.width / 2,
            crosshairY: this.renderer.height / 2,
            targetX: this.renderer.width / 2,
            targetY: this.renderer.height / 2,
            showCrosshair: false,
            ammo: this.maxAmmo,
            isReloading: false,
            reloadTimer: null,
        };
    }

    start() {
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
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
        this.targets = [];
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
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
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
        this.isPaused = false;
        clearInterval(this.timerInterval);
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        for (const w of Object.values(this.weapons)) {
            if (w.reloadTimer) clearTimeout(w.reloadTimer);
        }
        this.emit('gameOver', {
            score: this.score, hits: this.totalHits, shots: this.totalShots,
            accuracy: this.totalShots > 0 ? Math.round((this.totalHits / this.totalShots) * 100) : 0,
            maxCombo: this.maxCombo
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
        w.ammo--; this.totalShots++; this.muzzleFlashAlpha = 1.0;
        this.emit('ammo', handId, w.ammo, this.maxAmmo);
        let hit = false;
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            const dist = Math.sqrt((w.crosshairX - t.x) ** 2 + (w.crosshairY - t.y) ** 2);
            if (dist < t.radius + 15) {
                hit = true; this.totalHits++; this.combo++;
                if (this.combo > this.maxCombo) this.maxCombo = this.combo;
                const pts = this._calcPoints(t, dist);
                this.score += pts;
                this.particleSystem.spawnExplosion(t.x, t.y, t.color);
                this.emit('hit', t.x, t.y, `+${pts}`, false);
                this.targets.splice(i, 1);
                this.emit('score', this.score);
                this.emit('combo', this.combo);
                break;
            }
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

    // --- Private ---

    _calcPoints(t, dist) {
        let base = 100 + Math.floor((1 - dist / (t.radius + 15)) * 50);
        const mult = Math.min(1 + this.combo * 0.5, 5);
        if (t.radius < 25) base += 50;
        return Math.floor(base * mult);
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
            if (this.targets.length < this.maxTargets) this._spawnTarget();
            this._scheduleNextTarget();
        }, delay);
    }

    _spawnTarget() {
        const pad = 80, r = 20 + Math.random() * 25;
        const x = pad + Math.random() * (this.width - pad * 2);
        const y = pad + Math.random() * (this.height - pad * 2);
        const cols = [
            { main: '#ff3344', glow: 'rgba(255,51,68,0.5)' },
            { main: '#ff00e5', glow: 'rgba(255,0,229,0.5)' },
            { main: '#ff8800', glow: 'rgba(255,136,0,0.5)' },
            { main: '#aa33ff', glow: 'rgba(170,51,255,0.5)' }
        ];
        const c = cols[Math.floor(Math.random() * cols.length)];
        const spd = 0.5 + Math.random() * 1.5, ang = Math.random() * Math.PI * 2;
        this.targets.push({
            x, y, radius: r, color: c.main, glowColor: c.glow,
            vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
            lifetime: 5000 + Math.random() * 3000, born: Date.now(),
            pulsePhase: Math.random() * Math.PI * 2,
            type: Math.random() > 0.7 ? 'diamond' : 'circle'
        });
    }

    _updateTargets(now) {
        const pad = 40;
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            t.x += t.vx; t.y += t.vy;
            if (t.x < pad || t.x > this.width - pad) t.vx *= -1;
            if (t.y < pad || t.y > this.height - pad) t.vy *= -1;
            t.x = Math.max(pad, Math.min(this.width - pad, t.x));
            t.y = Math.max(pad, Math.min(this.height - pad, t.y));
            if (now - t.born > t.lifetime) {
                this.targets[i] = this.targets[this.targets.length - 1];
                this.targets.pop();
            }
        }
    }

    _gameLoop() {
        if (!this.isRunning) return;
        const now = Date.now();

        this.renderer.clear();
        this.renderer.drawBackground(now);

        this._updateTargets(now);
        this.renderer.drawTargets(this.targets, now);

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
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        for (const w of Object.values(this.weapons)) {
            if (w.reloadTimer) clearTimeout(w.reloadTimer);
        }
        window.removeEventListener('resize', this._handleResize);
        this.renderer.destroy();
    }
}
