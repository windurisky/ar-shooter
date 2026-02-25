/**
 * Game Engine — Targets, scoring, particles, crosshair, game loop.
 */
class Game {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.resize();
        this.isRunning = false;
        this.score = 0; this.combo = 0; this.maxCombo = 0;
        this.totalShots = 0; this.totalHits = 0;
        this.timeLeft = 60; this.timerInterval = null;
        this.maxAmmo = 6; this.ammo = this.maxAmmo;
        this.isReloading = false; this.reloadTime = 1500;
        this.crosshairX = this.width / 2; this.crosshairY = this.height / 2;
        this.showCrosshair = false;
        this.targets = []; this.maxTargets = 4;
        this.targetMinSpawnMs = 800; this.targetMaxSpawnMs = 2000;
        this.particles = []; this.muzzleFlashAlpha = 0;
        this.bgStars = []; this._initBgStars();
        this.onScoreUpdate = null; this.onAmmoUpdate = null;
        this.onComboUpdate = null; this.onTimeUpdate = null;
        this.onReloadStart = null; this.onReloadEnd = null; this.onGameOver = null;
        this._gameLoop = this._gameLoop.bind(this);
        this._handleResize = this.resize.bind(this);
        window.addEventListener('resize', this._handleResize);
    }
    resize() {
        this.width = window.innerWidth; this.height = window.innerHeight;
        this.canvas.width = this.width; this.canvas.height = this.height;
    }
    start() {
        this.score = 0; this.combo = 0; this.maxCombo = 0; this.totalShots = 0; this.totalHits = 0;
        this.timeLeft = 60; this.ammo = this.maxAmmo; this.isReloading = false;
        this.targets = []; this.particles = []; this.isRunning = true;
        this.timerInterval = setInterval(() => {
            this.timeLeft--;
            if (this.onTimeUpdate) this.onTimeUpdate(this.timeLeft);
            if (this.timeLeft <= 0) this.stop();
        }, 1000);
        this._scheduleNextTarget();
        this._animFrameId = requestAnimationFrame(this._gameLoop);
    }
    stop() {
        this.isRunning = false;
        clearInterval(this.timerInterval);
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        if (this.onGameOver) this.onGameOver({
            score: this.score, hits: this.totalHits, shots: this.totalShots,
            accuracy: this.totalShots > 0 ? Math.round((this.totalHits / this.totalShots) * 100) : 0,
            maxCombo: this.maxCombo
        });
    }
    updateAim(normX, normY) {
        this.crosshairX = normX * this.width;
        this.crosshairY = normY * this.height;
        this.showCrosshair = true;
    }
    hideCrosshair() { this.showCrosshair = false; }
    shoot() {
        if (!this.isRunning || this.isReloading) return;
        if (this.ammo <= 0) { this._startReload(); return; }
        this.ammo--; this.totalShots++; this.muzzleFlashAlpha = 1.0;
        if (this.onAmmoUpdate) this.onAmmoUpdate(this.ammo, this.maxAmmo);
        let hit = false;
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            const dist = Math.sqrt((this.crosshairX - t.x) ** 2 + (this.crosshairY - t.y) ** 2);
            if (dist < t.radius + 15) {
                hit = true; this.totalHits++; this.combo++;
                if (this.combo > this.maxCombo) this.maxCombo = this.combo;
                const pts = this._calcPoints(t, dist);
                this.score += pts;
                this._spawnExplosion(t.x, t.y, t.color);
                this._showHitMarker(t.x, t.y, `+${pts}`);
                this.targets.splice(i, 1);
                if (this.onScoreUpdate) this.onScoreUpdate(this.score);
                if (this.onComboUpdate) this.onComboUpdate(this.combo);
                break;
            }
        }
        if (!hit) {
            this.combo = 0;
            if (this.onComboUpdate) this.onComboUpdate(this.combo);
            this._showHitMarker(this.crosshairX, this.crosshairY - 20, 'MISS', true);
        }
        if (this.ammo <= 0) setTimeout(() => this._startReload(), 300);
    }
    _calcPoints(t, dist) {
        let base = 100 + Math.floor((1 - dist / (t.radius + 15)) * 50);
        const mult = Math.min(1 + this.combo * 0.5, 5);
        if (t.radius < 25) base += 50;
        return Math.floor(base * mult);
    }
    _startReload() {
        if (this.isReloading) return;
        this.isReloading = true;
        if (this.onReloadStart) this.onReloadStart(this.reloadTime);
        setTimeout(() => {
            this.ammo = this.maxAmmo; this.isReloading = false;
            if (this.onAmmoUpdate) this.onAmmoUpdate(this.ammo, this.maxAmmo);
            if (this.onReloadEnd) this.onReloadEnd();
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
        const x = pad + Math.random() * (this.width - pad * 2), y = pad + Math.random() * (this.height - pad * 2);
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
    _spawnExplosion(x, y, color) {
        const count = 20 + Math.floor(Math.random() * 15);
        for (let i = 0; i < count; i++) {
            const a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
            const s = 2 + Math.random() * 6;
            this.particles.push({
                x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
                life: 1, decay: 0.02 + Math.random() * 0.02, size: 2 + Math.random() * 4, color
            });
        }
        this.particles.push({
            x, y, vx: 0, vy: 0, life: 1, decay: 0.04, size: 5,
            color: '#ffffff', isRing: true, ringRadius: 10, ringExpand: 8
        });
    }
    _showHitMarker(x, y, text, isMiss = false) {
        const el = document.createElement('div');
        el.className = 'hit-marker' + (isMiss ? ' miss' : '');
        el.textContent = text; el.style.left = x + 'px'; el.style.top = y + 'px';
        document.getElementById('hit-markers').appendChild(el);
        setTimeout(() => el.remove(), 800);
    }
    _gameLoop() {
        if (!this.isRunning) return;
        this.ctx.clearRect(0, 0, this.width, this.height);
        this._drawBackground(); this._updateTargets(); this._drawTargets();
        this._updateParticles(); this._drawParticles();
        if (this.showCrosshair) this._drawCrosshair();
        if (this.muzzleFlashAlpha > 0) { this._drawMuzzleFlash(); this.muzzleFlashAlpha -= 0.08; }
        this._drawScanLines();
        this._animFrameId = requestAnimationFrame(this._gameLoop);
    }
    _initBgStars() {
        this.bgStars = [];
        for (let i = 0; i < 80; i++) {
            this.bgStars.push({
                x: Math.random() * 2000, y: Math.random() * 2000,
                size: 0.5 + Math.random() * 1.5,
                speed: 0.1 + Math.random() * 0.3,
                alpha: 0.2 + Math.random() * 0.6
            });
        }
    }
    _drawBackground() {
        // Dark gradient base
        const bg = this.ctx.createLinearGradient(0, 0, 0, this.height);
        bg.addColorStop(0, '#05051a'); bg.addColorStop(0.5, '#0a0a2e'); bg.addColorStop(1, '#0d0520');
        this.ctx.fillStyle = bg; this.ctx.fillRect(0, 0, this.width, this.height);
        const now = Date.now();
        // Animated grid
        this.ctx.save(); this.ctx.globalAlpha = 0.08;
        this.ctx.strokeStyle = '#00f0ff'; this.ctx.lineWidth = 0.5;
        const gridSize = 60; const offsetY = (now * 0.02) % gridSize;
        for (let x = 0; x < this.width; x += gridSize) {
            this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.height); this.ctx.stroke();
        }
        for (let y = -gridSize + offsetY; y < this.height + gridSize; y += gridSize) {
            this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(this.width, y); this.ctx.stroke();
        }
        this.ctx.restore();
        // Twinkling stars
        this.bgStars.forEach(s => {
            const twinkle = Math.sin(now * s.speed * 0.01 + s.x) * 0.3 + 0.7;
            this.ctx.save(); this.ctx.globalAlpha = s.alpha * twinkle;
            this.ctx.fillStyle = '#fff'; this.ctx.beginPath();
            this.ctx.arc(s.x % this.width, s.y % this.height, s.size, 0, Math.PI * 2);
            this.ctx.fill(); this.ctx.restore();
        });
        // Ambient glow orbs
        const drawOrb = (cx, cy, r, color) => {
            const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, color); g.addColorStop(1, 'transparent');
            this.ctx.fillStyle = g; this.ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        };
        this.ctx.save(); this.ctx.globalAlpha = 0.04;
        drawOrb(this.width * 0.2, this.height * 0.3, 300, '#00f0ff');
        drawOrb(this.width * 0.8, this.height * 0.7, 250, '#ff00e5');
        drawOrb(this.width * 0.5 + Math.sin(now * 0.0005) * 100, this.height * 0.5, 200, '#aa33ff');
        this.ctx.restore();
    }
    _updateTargets() {
        const now = Date.now(), pad = 40;
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            t.x += t.vx; t.y += t.vy;
            if (t.x < pad || t.x > this.width - pad) t.vx *= -1;
            if (t.y < pad || t.y > this.height - pad) t.vy *= -1;
            t.x = Math.max(pad, Math.min(this.width - pad, t.x));
            t.y = Math.max(pad, Math.min(this.height - pad, t.y));
            if (now - t.born > t.lifetime) this.targets.splice(i, 1);
        }
    }
    _drawTargets() {
        const now = Date.now();
        this.targets.forEach(t => {
            const pulse = Math.sin(now * 0.005 + t.pulsePhase) * 0.2 + 1;
            const age = (now - t.born) / t.lifetime;
            const fade = age > 0.8 ? 1 - ((age - 0.8) / 0.2) : 1;
            const r = t.radius * pulse;
            this.ctx.save(); this.ctx.globalAlpha = fade; this.ctx.translate(t.x, t.y);
            if (t.type === 'diamond') { this.ctx.rotate(Math.PI / 4 + now * 0.001); this._drawDiamond(r, t); }
            else this._drawCircle(r, t);
            this.ctx.restore();
        });
    }
    _drawCircle(r, t) {
        const g = this.ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2);
        g.addColorStop(0, t.glowColor); g.addColorStop(1, 'transparent');
        this.ctx.fillStyle = g; this.ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
        this.ctx.beginPath(); this.ctx.arc(0, 0, r, 0, Math.PI * 2);
        this.ctx.strokeStyle = t.color; this.ctx.lineWidth = 3; this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
        this.ctx.lineWidth = 2; this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, 0, 4, 0, Math.PI * 2);
        this.ctx.fillStyle = '#fff'; this.ctx.fill();
        [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach(a => {
            this.ctx.beginPath();
            this.ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
            this.ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
            this.ctx.strokeStyle = t.color; this.ctx.lineWidth = 1.5; this.ctx.stroke();
        });
    }
    _drawDiamond(r, t) {
        const g = this.ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.8);
        g.addColorStop(0, t.glowColor); g.addColorStop(1, 'transparent');
        this.ctx.fillStyle = g; this.ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
        this.ctx.beginPath(); this.ctx.moveTo(0, -r); this.ctx.lineTo(r, 0);
        this.ctx.lineTo(0, r); this.ctx.lineTo(-r, 0); this.ctx.closePath();
        this.ctx.strokeStyle = t.color; this.ctx.lineWidth = 3; this.ctx.stroke();
        const ir = r * 0.5;
        this.ctx.beginPath(); this.ctx.moveTo(0, -ir); this.ctx.lineTo(ir, 0);
        this.ctx.lineTo(0, ir); this.ctx.lineTo(-ir, 0); this.ctx.closePath();
        this.ctx.lineWidth = 2; this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, 0, 3, 0, Math.PI * 2);
        this.ctx.fillStyle = '#fff'; this.ctx.fill();
    }
    _drawCrosshair() {
        const x = this.crosshairX, y = this.crosshairY, sz = 20, gap = 6, now = Date.now();
        this.ctx.save(); this.ctx.translate(x, y);
        // Rotating arcs
        this.ctx.save(); this.ctx.rotate(now * 0.002);
        this.ctx.strokeStyle = 'rgba(0,240,255,0.3)'; this.ctx.lineWidth = 1;
        this.ctx.beginPath(); this.ctx.arc(0, 0, sz + 8, 0, Math.PI * 0.5); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, 0, sz + 8, Math.PI, Math.PI * 1.5); this.ctx.stroke();
        this.ctx.restore();
        // Lines
        this.ctx.strokeStyle = '#00f0ff'; this.ctx.lineWidth = 2;
        this.ctx.shadowColor = '#00f0ff'; this.ctx.shadowBlur = 10;
        [[0, -sz, 0, -gap], [0, gap, 0, sz], [-sz, 0, -gap, 0], [gap, 0, sz, 0]].forEach(([x1, y1, x2, y2]) => {
            this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2); this.ctx.stroke();
        });
        // Center dot
        this.ctx.shadowBlur = 15; this.ctx.beginPath(); this.ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
        this.ctx.fillStyle = '#00f0ff'; this.ctx.fill();
        // Pulse ring
        const p = Math.sin(now * 0.006) * 3;
        this.ctx.shadowBlur = 5; this.ctx.strokeStyle = 'rgba(0,240,255,0.3)'; this.ctx.lineWidth = 1;
        this.ctx.beginPath(); this.ctx.arc(0, 0, sz + p, 0, Math.PI * 2); this.ctx.stroke();
        this.ctx.restore();
    }
    _drawMuzzleFlash() {
        this.ctx.save(); this.ctx.globalAlpha = this.muzzleFlashAlpha * 0.15;
        this.ctx.fillStyle = '#ffcc33'; this.ctx.fillRect(0, 0, this.width, this.height); this.ctx.restore();
        if (this.showCrosshair) {
            const g = this.ctx.createRadialGradient(this.crosshairX, this.crosshairY, 0, this.crosshairX, this.crosshairY, 80);
            g.addColorStop(0, `rgba(255,200,50,${this.muzzleFlashAlpha * 0.5})`);
            g.addColorStop(0.4, `rgba(255,100,20,${this.muzzleFlashAlpha * 0.2})`);
            g.addColorStop(1, 'transparent');
            this.ctx.save(); this.ctx.fillStyle = g;
            this.ctx.fillRect(this.crosshairX - 80, this.crosshairY - 80, 160, 160); this.ctx.restore();
        }
    }
    _updateParticles() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.vx *= 0.98; p.life -= p.decay;
            if (p.isRing) p.ringRadius += p.ringExpand;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }
    _drawParticles() {
        this.particles.forEach(p => {
            this.ctx.save(); this.ctx.globalAlpha = p.life;
            if (p.isRing) {
                this.ctx.beginPath(); this.ctx.arc(p.x, p.y, p.ringRadius, 0, Math.PI * 2);
                this.ctx.strokeStyle = p.color; this.ctx.lineWidth = 2 * p.life;
                this.ctx.shadowColor = p.color; this.ctx.shadowBlur = 10; this.ctx.stroke();
            } else {
                this.ctx.beginPath(); this.ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
                this.ctx.fillStyle = p.color; this.ctx.shadowColor = p.color;
                this.ctx.shadowBlur = 8; this.ctx.fill();
            }
            this.ctx.restore();
        });
    }
    _drawScanLines() {
        this.ctx.save(); this.ctx.globalAlpha = 0.03;
        for (let y = 0; y < this.height; y += 3) { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, y, this.width, 1); }
        this.ctx.restore();
        const v = this.ctx.createRadialGradient(this.width / 2, this.height / 2, this.height * 0.3, this.width / 2, this.height / 2, this.height * 0.8);
        v.addColorStop(0, 'transparent'); v.addColorStop(1, 'rgba(0,0,0,0.4)');
        this.ctx.fillStyle = v; this.ctx.fillRect(0, 0, this.width, this.height);
    }
    destroy() {
        this.isRunning = false; clearInterval(this.timerInterval);
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        if (this._targetTimeout) clearTimeout(this._targetTimeout);
        window.removeEventListener('resize', this._handleResize);
    }
}
