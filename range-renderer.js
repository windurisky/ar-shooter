/**
 * RangeRenderer — Three.js cyberpunk shooting-range corridor + target plank meshes.
 * Renders on #range-canvas (behind the 2D game canvas).
 *
 * Public API used by Game:
 *   addTarget(target)      — create a 3D plank mesh for a new logical target
 *   removeTarget(target)   — remove and dispose its mesh
 *   syncTargets(targets)   — update positions, animate states, project screen coords
 */
class RangeRenderer {
    // Lane definitions: z (depth), half-width of slide bounds, spawn weight
    static LANES = [
        { z: -12, halfWidth: 3.0, weight: 0.30, label: 'far'  },
        { z: -8,  halfWidth: 2.6, weight: 0.35, label: 'mid'  },
        { z: -5,  halfWidth: 2.2, weight: 0.35, label: 'near' },
    ];

    // Kind definitions: texture key, slide speed range, base score, scale, hostage flag
    static KINDS = {
        cyborg:   { texKey: 'cyborg',         speedRange: [0.005, 0.012], basePoints: 100, scale: 1.0, hostage: false, weight: 0.70 },
        spider:   { texKey: 'spider',          speedRange: [0.012, 0.022], basePoints: 200, scale: 0.7, hostage: false, weight: 0.30 },
        hostageM: { texKey: 'hostageM',        speedRange: [0.005, 0.010], basePoints: -100, scale: 1.0, hostage: true  },
        hostageF: { texKey: 'hostageF',        speedRange: [0.005, 0.010], basePoints: -100, scale: 1.0, hostage: true  },
    };

    static HOSTAGE_RATE = 0.18;

    // Rise/fall animation durations (ms)
    static RISE_MS  = 250;
    static FALL_MS  = 300;

    constructor(canvas) {
        this.canvas = canvas;
        this.width  = window.innerWidth;
        this.height = window.innerHeight;

        // --- Three.js scene ---
        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(62, this.width / this.height, 0.1, 60);
        this.camera.position.set(0, 0.55, 0.5);
        this.camera.rotation.x = -0.13; // downward tilt to show floor recede

        this.threeRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        this.threeRenderer.setSize(this.width, this.height);
        this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.threeRenderer.setClearColor(0x000000, 0);
        this.threeRenderer.shadowMap.enabled = false;

        // Camera shake state
        this._shake = { x: 0, y: 0, decay: 0 };

        // Mesh pool: target.id → { group, wireMesh }
        this._meshPool = new Map();
        // Reusable vectors for per-frame projection (avoid GC pressure)
        this._projVec  = new THREE.Vector3();
        this._projVecR = new THREE.Vector3();

        // Textures — load async, stubs until ready
        this.textures = {};
        this._loadTextures();

        // Build scene geometry
        this._buildCorridor();

        // Animate loop
        this._animate = this._animate.bind(this);
        this._startTime = Date.now();
        this._animFrameId = requestAnimationFrame(this._animate);

        // Resize
        this._onResize = () => this._handleResize();
        window.addEventListener('resize', this._onResize);
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /** Called by Game when a new logical target is spawned. */
    addTarget(target) {
        if (this._meshPool.has(target.id)) return;
        const group = this._createPlankMesh(target.kind);
        // Start below lane (will rise)
        const lane = RangeRenderer.LANES[target.lane];
        group.position.set(target.worldX, target.worldY - 2.0, lane.z);
        this.scene.add(group);

        // Hanging wire (thin line from rail down to plank top — updated in syncTargets)
        const wireMat = new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.4 });
        const wirePositions = new Float32Array([
            target.worldX, 1.05, lane.z,   // top anchor (rail)
            target.worldX, -0.5, lane.z,   // plank top (placeholder, updated in sync)
        ]);
        const wireGeo = new THREE.BufferGeometry();
        wireGeo.setAttribute('position', new THREE.BufferAttribute(wirePositions, 3));
        const wire = new THREE.Line(wireGeo, wireMat);
        this.scene.add(wire);

        this._meshPool.set(target.id, { group, wire });
    }

    /** Called by Game when a target is removed (hit or expired). */
    removeTarget(target) {
        const entry = this._meshPool.get(target.id);
        if (!entry) return;
        this.scene.remove(entry.group);
        this.scene.remove(entry.wire);
        this._disposeGroup(entry.group);
        entry.wire.geometry.dispose();
        entry.wire.material.dispose();
        this._meshPool.delete(target.id);
    }

    /**
     * Called once per game frame (synchronously from Game._gameLoop).
     * Updates mesh positions, drives rise/fall animation, and projects
     * each target's screen position + radius back onto the logical target object.
     */
    syncTargets(targets, now) {
        const halfW = this.width  / 2;
        const halfH = this.height / 2;

        for (const t of targets) {
            const entry = this._meshPool.get(t.id);
            if (!entry) continue;
            const { group, wire } = entry;
            const lane = RangeRenderer.LANES[t.lane];
            const kindCfg = RangeRenderer.KINDS[t.kind];

            // ── Vertical position driven by state ──
            let worldY = t.worldY;
            const elapsed = now - t.stateStart;

            if (t.state === 'rising') {
                const p = Math.min(elapsed / RangeRenderer.RISE_MS, 1);
                const e = this._easeOutBack(p);
                worldY = (t.worldY - 2.0) + e * 2.0;
            } else if (t.state === 'falling') {
                const p = Math.min(elapsed / RangeRenderer.FALL_MS, 1);
                worldY = t.worldY - p * 2.5;
                group.rotation.x = p * Math.PI * 0.5; // flip forward
            }

            group.position.set(t.worldX, worldY, lane.z);

            // Update hanging wire: top = rail, bottom = plank top edge
            if (wire) {
                const attr = wire.geometry.attributes.position;
                attr.setXYZ(0, t.worldX, 1.05, lane.z);
                attr.setXYZ(1, t.worldX, worldY + 0.9 * kindCfg.scale, lane.z);
                attr.needsUpdate = true;
            }

            // ── Project to screen space (reuse cached vectors) ──
            this._projVec.set(t.worldX, worldY, lane.z);
            this._projVec.project(this.camera);
            t.screenX = (this._projVec.x * halfW) + halfW;
            t.screenY = -(this._projVec.y * halfH) + halfH;

            // Radius: project a point 0.55 units to the right and measure pixel distance
            this._projVecR.set(t.worldX + 0.55 * kindCfg.scale, worldY, lane.z);
            this._projVecR.project(this.camera);
            const screenEdgeX = (this._projVecR.x * halfW) + halfW;
            t.screenRadius = Math.abs(screenEdgeX - t.screenX);
        }
    }

    /** Trigger a brief camera shake (e.g. on hostage hit). */
    nudge() {
        this._shake.x = (Math.random() - 0.5) * 0.05;
        this._shake.y = (Math.random() - 0.5) * 0.03;
        this._shake.decay = 1.0;
    }

    // ─── Private: animation loop ───────────────────────────────────────────────

    _animate() {
        this._animFrameId = requestAnimationFrame(this._animate);

        // Camera shake decay
        if (this._shake.decay > 0.001) {
            this.camera.position.x = this._shake.x * this._shake.decay;
            this.camera.position.y = 0.55 + this._shake.y * this._shake.decay;
            this._shake.decay *= 0.82;
        } else {
            this.camera.position.x = 0;
            this.camera.position.y = 0.55;
        }

        this.threeRenderer.render(this.scene, this.camera);
    }

    // ─── Private: corridor geometry ────────────────────────────────────────────

    _buildCorridor() {
        // Fog — deep magenta-tinted black, pushed back so far lane stays visible
        this.scene.fog = new THREE.Fog(0x0a061e, 10, 35);

        // Ambient — warm indigo, high enough to reveal surfaces
        this.scene.add(new THREE.AmbientLight(0x6050b0, 1.0));

        // Hemisphere fill (sky=magenta tint, ground=dark purple) — gives walls/floor natural falloff
        const hemi = new THREE.HemisphereLight(0xff66cc, 0x1a0f36, 0.55);
        hemi.position.set(0, 5, 0);
        this.scene.add(hemi);

        // Key light (front-above, cool white) — brightens plank fronts
        const keyLight = new THREE.DirectionalLight(0xeaf2ff, 1.0);
        keyLight.position.set(0, 6, 3);
        this.scene.add(keyLight);

        // Rim lights — magenta left, cyan right
        const rimL = new THREE.DirectionalLight(0xff00e5, 0.7);
        rimL.position.set(-6, 1, -6);
        this.scene.add(rimL);

        const rimR = new THREE.DirectionalLight(0x00f0ff, 0.7);
        rimR.position.set(6, 1, -6);
        this.scene.add(rimR);

        this._buildFloor();
        this._buildWalls();
        this._buildCeiling();
        this._buildLaneRails();
        this._buildSpotlights();
        this._buildFloorWash();
        this._buildGroundHaze();
    }

    _buildFloor() {
        // Rich floor texture: dark gradient + grid + vertical reflection streaks
        const W = 1024, H = 1024;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');

        // Base gradient — deep purple toward center, darker at edges
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, '#0a0518');
        g.addColorStop(0.5, '#1a0d38');
        g.addColorStop(1, '#0a0518');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Vertical neon "reflection streaks" — soft bright columns matching wall strip positions
        const streaks = [
            { x: 0.05, col: 'rgba(255, 0, 229, 0.55)' },   // far-left magenta
            { x: 0.18, col: 'rgba(0, 240, 255, 0.35)' },
            { x: 0.82, col: 'rgba(0, 240, 255, 0.35)' },
            { x: 0.95, col: 'rgba(255, 0, 229, 0.55)' },   // far-right magenta
            { x: 0.50, col: 'rgba(150, 100, 255, 0.20)' }, // center wash
        ];
        for (const s of streaks) {
            const grad = ctx.createLinearGradient(s.x * W - 60, 0, s.x * W + 60, 0);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(0.5, s.col);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(s.x * W - 60, 0, 120, H);
        }

        // Grid lines (subtle)
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.18)';
        ctx.lineWidth = 2;
        const cells = 8;
        for (let i = 0; i <= cells; i++) {
            const p = (i * W) / cells;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
        }

        // Horizontal scan streaks (small bright highlights)
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        for (let y = 0; y < H; y += 16) {
            ctx.fillRect(0, y, W, 1);
        }

        const floorTex = new THREE.CanvasTexture(c);
        floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
        floorTex.repeat.set(1, 4);
        floorTex.colorSpace = THREE.SRGBColorSpace;
        floorTex.anisotropy = 8;

        const floorGeo = new THREE.PlaneGeometry(12, 40);
        const floorMat = new THREE.MeshStandardMaterial({
            map: floorTex,
            color: 0xffffff,
            roughness: 0.25,
            metalness: 0.9,
            emissive: 0x1a0a30,
            emissiveMap: floorTex,
            emissiveIntensity: 0.35,
        });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(0, -1.8, -12);
        this.scene.add(floor);
    }

    _buildWalls() {
        // Bake a subtle panel texture on the walls (vertical seams)
        const wallTex = this._buildWallTexture();
        const wallMat = new THREE.MeshStandardMaterial({
            map: wallTex,
            color: 0x2a1a50,
            roughness: 0.7,
            metalness: 0.45,
        });

        // Left wall
        const wallL = new THREE.Mesh(new THREE.PlaneGeometry(40, 5), wallMat.clone());
        wallL.rotation.y = Math.PI / 2;
        wallL.position.set(-5.5, 0.7, -12);
        this.scene.add(wallL);

        // Right wall
        const wallR = new THREE.Mesh(new THREE.PlaneGeometry(40, 5), wallMat.clone());
        wallR.rotation.y = -Math.PI / 2;
        wallR.position.set(5.5, 0.7, -12);
        this.scene.add(wallR);

        // Back wall
        const wallBack = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMat.clone());
        wallBack.position.set(0, 0.7, -30);
        this.scene.add(wallBack);

        // Neon strips — alternating magenta/cyan along each wall
        const stripColors = [0xff00e5, 0x00f0ff];
        const stripZPositions = [-4, -6, -8, -10, -12, -14, -16, -18, -20];
        stripZPositions.forEach((z, i) => {
            const col = stripColors[i % 2];
            const mat = new THREE.MeshStandardMaterial({
                color: col, emissive: col, emissiveIntensity: 1.5,
                roughness: 0.3, metalness: 0.5,
            });
            const geo = new THREE.BoxGeometry(0.04, 3.2, 0.04);

            const stripL = new THREE.Mesh(geo, mat);
            stripL.position.set(-5.3, 0.7, z);
            this.scene.add(stripL);

            const stripR = new THREE.Mesh(geo, mat.clone());
            stripR.position.set(5.3, 0.7, z);
            this.scene.add(stripR);

            // Point light per strip pair (low intensity, short range)
            const light = new THREE.PointLight(col, 0.3, 5);
            light.position.set(0, 1, z);
            this.scene.add(light);
        });
    }

    _buildCeiling() {
        const ceilMat = new THREE.MeshStandardMaterial({ color: 0x0a0818, roughness: 0.9, metalness: 0.1 });
        const ceil = new THREE.Mesh(new THREE.PlaneGeometry(12, 40), ceilMat);
        ceil.rotation.x = Math.PI / 2;
        ceil.position.set(0, 2.5, -12);
        this.scene.add(ceil);

        // Horizontal neon tubes on ceiling
        const tubePositions = [-6, -10, -14, -18, -22];
        const tubeColors = [0x00f0ff, 0xff00e5, 0x00f0ff, 0xff00e5, 0x00f0ff];
        tubePositions.forEach((z, i) => {
            const col = tubeColors[i];
            const mat = new THREE.MeshStandardMaterial({
                color: col, emissive: col, emissiveIntensity: 1.2,
                roughness: 0.3, metalness: 0.4,
            });
            const tube = new THREE.Mesh(new THREE.BoxGeometry(9, 0.06, 0.06), mat);
            tube.position.set(0, 2.4, z);
            this.scene.add(tube);

            // Downward point light from each tube
            const light = new THREE.PointLight(col, 0.5, 8);
            light.position.set(0, 2.0, z);
            this.scene.add(light);
        });
    }

    _buildLaneRails() {
        // Horizontal rail at top of each lane — targets hang from these
        RangeRenderer.LANES.forEach(lane => {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 0.8,
                roughness: 0.3, metalness: 0.7,
            });
            const rail = new THREE.Mesh(new THREE.BoxGeometry(lane.halfWidth * 2.2, 0.05, 0.05), mat);
            rail.position.set(0, 1.05, lane.z);
            this.scene.add(rail);
        });
    }

    _buildWallTexture() {
        const size = 512;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        // Base gradient (darker at top, lighter mid)
        const g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, '#140a2a');
        g.addColorStop(0.5, '#24144a');
        g.addColorStop(1, '#0e0720');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        // Vertical panel seams
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 2;
        for (let x = 0; x < size; x += size / 4) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
        }
        // Soft horizontal wear band
        ctx.fillStyle = 'rgba(255,255,255,0.02)';
        ctx.fillRect(0, size * 0.35, size, size * 0.1);
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(10, 1);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    _buildFloorWash() {
        // Thin emissive cyan bars along the wall/floor junction — fake neon wash
        const washMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
        const washGeoL = new THREE.BoxGeometry(0.08, 0.04, 40);
        const washL = new THREE.Mesh(washGeoL, washMat);
        washL.position.set(-5.45, -1.78, -12);
        this.scene.add(washL);

        const washR = new THREE.Mesh(washGeoL.clone(), washMat);
        washR.position.set(5.45, -1.78, -12);
        this.scene.add(washR);

        // Soft point lights walking down the corridor, low to the floor
        for (let z = -4; z >= -24; z -= 4) {
            const col = (z / 4) % 2 === 0 ? 0x00f0ff : 0xff00e5;
            const light = new THREE.PointLight(col, 0.55, 6);
            light.position.set(0, -1.5, z);
            this.scene.add(light);
        }
    }

    _buildGroundHaze() {
        // Big semi-transparent plane just above the floor — fake ground fog
        const size = 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(180, 120, 255, 0.55)');
        g.addColorStop(0.5, 'rgba(80, 40, 160, 0.15)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        const tex = new THREE.CanvasTexture(c);

        const hazeMat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
        });
        const hazeGeo = new THREE.PlaneGeometry(14, 40);
        const haze = new THREE.Mesh(hazeGeo, hazeMat);
        haze.rotation.x = -Math.PI / 2;
        haze.position.set(0, -1.3, -12);
        this.scene.add(haze);
    }

    _buildSpotlights() {
        // Hanging fixture boxes above each lane with a warm spotlight
        RangeRenderer.LANES.forEach((lane, i) => {
            const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.8 });
            const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.2), fixtureMat);
            fixture.position.set(0, 2.3, lane.z);
            this.scene.add(fixture);

            const spotlight = new THREE.PointLight(0xfff4cc, 1.2, 10);
            spotlight.position.set(0, 2.1, lane.z);
            this.scene.add(spotlight);
        });
    }

    // ─── Private: plank mesh factory ───────────────────────────────────────────

    _createPlankMesh(kind) {
        const kindCfg = RangeRenderer.KINDS[kind];
        const s = kindCfg.scale;
        const group = new THREE.Group();

        const isHostage = kindCfg.hostage;
        // Accent color: amber for hostages (warning), cyan for enemies
        const accentHex = isHostage ? 0xffaa22 : 0x00f0ff;

        // ── Backing plate (dark metallic board, same for all kinds) ──
        const backMat = new THREE.MeshStandardMaterial({
            color: 0x120a26,
            roughness: 0.55,
            metalness: 0.75,
        });
        const backGeo = new THREE.BoxGeometry(1.4 * s, 2.0 * s, 0.06);
        const back = new THREE.Mesh(backGeo, backMat);
        group.add(back);

        // ── Image plane (fills most of the backing) ──
        const texKey = kindCfg.texKey;
        const tex = this.textures[texKey] || null;
        const imgMat = new THREE.MeshBasicMaterial({
            map: tex,
            toneMapped: false,
            side: THREE.FrontSide,
        });
        const imgGeo = new THREE.PlaneGeometry(1.28 * s, 1.72 * s);
        const img = new THREE.Mesh(imgGeo, imgMat);
        img.position.set(0, -0.05 * s, 0.032);
        group.add(img);

        // ── Edge strips (emissive neon border on all 4 sides) ──
        const stripMat = new THREE.MeshBasicMaterial({ color: accentHex });
        const w = 1.4 * s, h = 2.0 * s, t = 0.035;
        const stripTop    = new THREE.Mesh(new THREE.BoxGeometry(w, t, 0.04), stripMat);
        const stripBot    = new THREE.Mesh(new THREE.BoxGeometry(w, t, 0.04), stripMat);
        const stripLeft   = new THREE.Mesh(new THREE.BoxGeometry(t, h, 0.04), stripMat);
        const stripRight  = new THREE.Mesh(new THREE.BoxGeometry(t, h, 0.04), stripMat);
        stripTop.position.set(0,  h / 2 - t / 2, 0.04);
        stripBot.position.set(0, -h / 2 + t / 2, 0.04);
        stripLeft.position.set(-w / 2 + t / 2, 0, 0.04);
        stripRight.position.set(w / 2 - t / 2, 0, 0.04);
        group.add(stripTop, stripBot, stripLeft, stripRight);

        // ── Banner label at top ──
        const bannerText = isHostage ? '⚠ CIVILIAN' : 'CYBER TARGET';
        const bannerTex = this._getBannerTexture(bannerText, accentHex);
        const bannerMat = new THREE.MeshBasicMaterial({
            map: bannerTex,
            transparent: true,
            toneMapped: false,
        });
        const bannerGeo = new THREE.PlaneGeometry(1.1 * s, 0.22 * s);
        const banner = new THREE.Mesh(bannerGeo, bannerMat);
        banner.position.set(0, h / 2 - 0.2 * s, 0.05);
        group.add(banner);

        // ── Faint accent glow light in front of plank (only for hostages, to sell warning) ──
        if (isHostage) {
            const warnLight = new THREE.PointLight(accentHex, 0.4, 3);
            warnLight.position.set(0, 0, 0.3);
            group.add(warnLight);
        }

        // Store references so we can swap texture in later if async
        group.userData.imgMesh = img;
        group.userData.texKey = texKey;

        return group;
    }

    // Generate an emissive-feeling text banner as a CanvasTexture, cached by key.
    _getBannerTexture(text, accentHex) {
        if (!this._bannerCache) this._bannerCache = new Map();
        const key = text + ':' + accentHex;
        if (this._bannerCache.has(key)) return this._bannerCache.get(key);

        const W = 512, H = 96;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');

        // Transparent background
        ctx.clearRect(0, 0, W, H);

        // Rounded dark backing bar
        const bgR = 14;
        ctx.fillStyle = 'rgba(8, 4, 20, 0.85)';
        this._roundRect(ctx, 4, 4, W - 8, H - 8, bgR);
        ctx.fill();

        // Accent border
        const hex = '#' + accentHex.toString(16).padStart(6, '0');
        ctx.strokeStyle = hex;
        ctx.lineWidth = 3;
        this._roundRect(ctx, 4, 4, W - 8, H - 8, bgR);
        ctx.stroke();

        // Text
        ctx.font = '900 46px Orbitron, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = hex;
        ctx.shadowBlur = 20;
        ctx.fillStyle = hex;
        ctx.fillText(text, W / 2, H / 2 + 2);
        ctx.shadowBlur = 0;
        // Brighter inner
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.35;
        ctx.fillText(text, W / 2, H / 2 + 2);
        ctx.globalAlpha = 1;

        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        this._bannerCache.set(key, tex);
        return tex;
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // ─── Private: texture loading ───────────────────────────────────────────────

    _loadTextures() {
        const loader = new THREE.TextureLoader();
        const entries = [
            ['cyborg',   'assets/images/target-cyborg.webp'],
            ['spider',   'assets/images/target-spiderbot.webp'],
            ['hostageM', 'assets/images/target-innocent-male.webp'],
            ['hostageF', 'assets/images/target-innocent-female.webp'],
        ];
        entries.forEach(([key, path]) => {
            loader.load(path, (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.anisotropy = Math.min(4, this.threeRenderer.capabilities.getMaxAnisotropy());
                this.textures[key] = tex;

                // Patch any already-created meshes that are waiting for this texture
                for (const { group } of this._meshPool.values()) {
                    if (group.userData.texKey === key && group.userData.imgMesh) {
                        group.userData.imgMesh.material.map = tex;
                        group.userData.imgMesh.material.needsUpdate = true;
                    }
                }
            });
        });
    }

    // ─── Private: easing ───────────────────────────────────────────────────────

    _easeOutBack(t) {
        const c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }

    // ─── Private: resize ───────────────────────────────────────────────────────

    _handleResize() {
        this.width  = window.innerWidth;
        this.height = window.innerHeight;
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        this.threeRenderer.setSize(this.width, this.height);
    }

    // ─── Private: disposal ─────────────────────────────────────────────────────

    _disposeGroup(group) {
        group.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (obj.material.map) obj.material.map = null; // don't dispose shared textures
                obj.material.dispose();
            }
        });
    }

    destroy() {
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        window.removeEventListener('resize', this._onResize);
        this.threeRenderer.dispose();
    }
}
