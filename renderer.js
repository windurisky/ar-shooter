/**
 * Renderer — 2D canvas drawing: crosshairs, particles, muzzle flash, scan-line overlay.
 * Background and target rendering are handled by RangeRenderer (Three.js) on #range-canvas.
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

        // Offscreen canvas for scan-line overlay
        this._scanLineCanvas = document.createElement('canvas');
        this._scanLineCtx = this._scanLineCanvas.getContext('2d');

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

    // Background is now rendered by RangeRenderer (Three.js) on #range-canvas.
    // This method is kept as a no-op so call sites don't need to change.
    drawBackground(now) {}

    // --- Targets ---

    // Targets are now rendered by RangeRenderer (Three.js) on #range-canvas.
    drawTargets(targets, now) {}

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
