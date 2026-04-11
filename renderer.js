/**
 * Renderer — All 2D canvas drawing: background, targets, crosshairs,
 * particles, muzzle flash, and scan-line overlay.
 */
class Renderer {
    // Crosshair colors per hand (MediaPipe "Left" = user's right hand due to mirror)
    static CROSSHAIR_COLORS = {
        Left: { main: '#ff00e5', glow: 'rgba(255,0,229,', shadow: '#ff00e5' },   // magenta — user's right
        Right: { main: '#00f0ff', glow: 'rgba(0,240,255,', shadow: '#00f0ff' },   // cyan — user's left
    };

    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.width = 0;
        this.height = 0;

        // Background stars
        this.bgStars = [];
        this._initBgStars();

        // Offscreen canvases for static overlays
        this._scanLineCanvas = document.createElement('canvas');
        this._scanLineCtx = this._scanLineCanvas.getContext('2d');
        this._bgGradientCanvas = document.createElement('canvas');
        this._bgGradientCtx = this._bgGradientCanvas.getContext('2d');

        this.resize();
    }

    resize() {
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this._rebuildOffscreenCanvases();
    }

    clear() {
        this.ctx.clearRect(0, 0, this.width, this.height);
    }

    // --- Background ---

    drawBackground(now) {
        this.ctx.drawImage(this._bgGradientCanvas, 0, 0);

        // Animated grid
        this.ctx.save();
        this.ctx.globalAlpha = 0.08;
        this.ctx.strokeStyle = '#00f0ff';
        this.ctx.lineWidth = 0.5;
        const gridSize = 60;
        const offsetY = (now * 0.02) % gridSize;
        for (let x = 0; x < this.width; x += gridSize) {
            this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.height); this.ctx.stroke();
        }
        for (let y = -gridSize + offsetY; y < this.height + gridSize; y += gridSize) {
            this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(this.width, y); this.ctx.stroke();
        }
        this.ctx.restore();

        // Stars
        this.bgStars.forEach(s => {
            const twinkle = Math.sin(now * s.speed * 0.01 + s.x) * 0.3 + 0.7;
            this.ctx.save();
            this.ctx.globalAlpha = s.alpha * twinkle;
            this.ctx.fillStyle = '#fff';
            this.ctx.beginPath();
            this.ctx.arc(s.x % this.width, s.y % this.height, s.size, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
        });

        // Nebula orbs
        const drawOrb = (cx, cy, r, color) => {
            const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, color); g.addColorStop(1, 'transparent');
            this.ctx.fillStyle = g; this.ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        };
        this.ctx.save();
        this.ctx.globalAlpha = 0.04;
        drawOrb(this.width * 0.2, this.height * 0.3, 300, '#00f0ff');
        drawOrb(this.width * 0.8, this.height * 0.7, 250, '#ff00e5');
        drawOrb(this.width * 0.5 + Math.sin(now * 0.0005) * 100, this.height * 0.5, 200, '#aa33ff');
        this.ctx.restore();
    }

    // --- Targets ---

    drawTargets(targets, now) {
        targets.forEach(t => {
            const pulse = Math.sin(now * 0.005 + t.pulsePhase) * 0.2 + 1;
            const age = (now - t.born) / t.lifetime;
            const fade = age > 0.8 ? 1 - ((age - 0.8) / 0.2) : 1;
            const r = t.radius * pulse;
            this.ctx.save();
            this.ctx.globalAlpha = fade;
            this.ctx.translate(t.x, t.y);
            if (t.type === 'diamond') {
                this.ctx.rotate(Math.PI / 4 + now * 0.001);
                this._drawDiamond(r, t);
            } else {
                this._drawCircle(r, t);
            }
            this.ctx.restore();
        });
    }

    // --- Crosshairs ---

    drawCrosshairs(weapons, now) {
        for (const [handId, w] of Object.entries(weapons)) {
            if (w.showCrosshair) this._drawCrosshair(handId, w, now);
        }
    }

    // --- Muzzle Flash ---

    drawMuzzleFlash(weapons, alpha) {
        if (alpha <= 0) return;
        this.ctx.save();
        this.ctx.globalAlpha = alpha * 0.15;
        this.ctx.fillStyle = '#ffcc33';
        this.ctx.fillRect(0, 0, this.width, this.height);
        this.ctx.restore();
        for (const w of Object.values(weapons)) {
            if (w.showCrosshair) {
                const g = this.ctx.createRadialGradient(w.crosshairX, w.crosshairY, 0, w.crosshairX, w.crosshairY, 80);
                g.addColorStop(0, `rgba(255,200,50,${alpha * 0.5})`);
                g.addColorStop(0.4, `rgba(255,100,20,${alpha * 0.2})`);
                g.addColorStop(1, 'transparent');
                this.ctx.save();
                this.ctx.fillStyle = g;
                this.ctx.fillRect(w.crosshairX - 80, w.crosshairY - 80, 160, 160);
                this.ctx.restore();
            }
        }
    }

    // --- Particles ---

    drawParticles(particles) {
        particles.forEach(p => {
            this.ctx.save();
            this.ctx.globalAlpha = p.life;
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

    // --- Scan Lines (cached) ---

    drawScanLines() {
        this.ctx.drawImage(this._scanLineCanvas, 0, 0);
    }

    // --- Private helpers ---

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

    _rebuildOffscreenCanvases() {
        // Scan lines + vignette
        this._scanLineCanvas.width = this.width;
        this._scanLineCanvas.height = this.height;
        const slCtx = this._scanLineCtx;
        slCtx.clearRect(0, 0, this.width, this.height);
        slCtx.globalAlpha = 0.03;
        slCtx.fillStyle = '#000';
        for (let y = 0; y < this.height; y += 3) {
            slCtx.fillRect(0, y, this.width, 1);
        }
        slCtx.globalAlpha = 1;
        const v = slCtx.createRadialGradient(
            this.width / 2, this.height / 2, this.height * 0.3,
            this.width / 2, this.height / 2, this.height * 0.8
        );
        v.addColorStop(0, 'transparent');
        v.addColorStop(1, 'rgba(0,0,0,0.4)');
        slCtx.fillStyle = v;
        slCtx.fillRect(0, 0, this.width, this.height);

        // Background gradient
        this._bgGradientCanvas.width = this.width;
        this._bgGradientCanvas.height = this.height;
        const bgCtx = this._bgGradientCtx;
        const bg = bgCtx.createLinearGradient(0, 0, 0, this.height);
        bg.addColorStop(0, '#05051a');
        bg.addColorStop(0.5, '#0a0a2e');
        bg.addColorStop(1, '#0d0520');
        bgCtx.fillStyle = bg;
        bgCtx.fillRect(0, 0, this.width, this.height);
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

    _drawCrosshair(handId, w, now) {
        const x = w.crosshairX, y = w.crosshairY, sz = 20, gap = 6;
        const colors = Renderer.CROSSHAIR_COLORS[handId] || Renderer.CROSSHAIR_COLORS.Right;
        this.ctx.save(); this.ctx.translate(x, y);
        // Rotating arcs
        this.ctx.save(); this.ctx.rotate(now * 0.002);
        this.ctx.strokeStyle = colors.glow + '0.3)'; this.ctx.lineWidth = 1;
        this.ctx.beginPath(); this.ctx.arc(0, 0, sz + 8, 0, Math.PI * 0.5); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, 0, sz + 8, Math.PI, Math.PI * 1.5); this.ctx.stroke();
        this.ctx.restore();
        // Lines
        this.ctx.strokeStyle = colors.main; this.ctx.lineWidth = 2;
        this.ctx.shadowColor = colors.shadow; this.ctx.shadowBlur = 10;
        [[0, -sz, 0, -gap], [0, gap, 0, sz], [-sz, 0, -gap, 0], [gap, 0, sz, 0]].forEach(([x1, y1, x2, y2]) => {
            this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2); this.ctx.stroke();
        });
        // Center dot
        this.ctx.shadowBlur = 15; this.ctx.beginPath(); this.ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
        this.ctx.fillStyle = colors.main; this.ctx.fill();
        // Pulse ring
        const p = Math.sin(now * 0.006) * 3;
        this.ctx.shadowBlur = 5; this.ctx.strokeStyle = colors.glow + '0.3)'; this.ctx.lineWidth = 1;
        this.ctx.beginPath(); this.ctx.arc(0, 0, sz + p, 0, Math.PI * 2); this.ctx.stroke();
        this.ctx.restore();
    }

    destroy() {
        // No listeners to clean up; Game owns the resize listener
    }
}
