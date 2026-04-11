/**
 * ParticleSystem — Manages explosion particles and ring effects.
 */
class ParticleSystem {
    constructor() {
        this.particles = [];
    }
    spawnExplosion(x, y, color) {
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
    update() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.vx *= 0.98; p.life -= p.decay;
            if (p.isRing) p.ringRadius += p.ringExpand;
            if (p.life <= 0) {
                this.particles[i] = this.particles[this.particles.length - 1];
                this.particles.pop();
            }
        }
    }
    getParticles() {
        return this.particles;
    }
    clear() {
        this.particles = [];
    }
}
