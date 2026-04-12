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
        { z: -10, halfWidth: 2.8, weight: 0.30, label: 'far'  },
        { z: -6,  halfWidth: 2.4, weight: 0.35, label: 'mid'  },
        { z: -3,  halfWidth: 2.0, weight: 0.35, label: 'near' },
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
        this.camera = new THREE.PerspectiveCamera(60, this.width / this.height, 0.1, 50);
        this.camera.position.set(0, 0.3, 0);
        this.camera.rotation.x = -0.06; // slight downward tilt

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
            this.camera.position.y = 0.3 + this._shake.y * this._shake.decay;
            this._shake.decay *= 0.82;
        } else {
            this.camera.position.x = 0;
            this.camera.position.y = 0.3;
        }

        this.threeRenderer.render(this.scene, this.camera);
    }

    // ─── Private: corridor geometry ────────────────────────────────────────────

    _buildCorridor() {
        // Fog — deep magenta-tinted black
        this.scene.fog = new THREE.Fog(0x08051a, 8, 28);

        // Ambient
        this.scene.add(new THREE.AmbientLight(0x4030a0, 0.6));

        // Key light (front-above)
        const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
        keyLight.position.set(0, 5, 2);
        this.scene.add(keyLight);

        // Rim lights — magenta left, cyan right
        const rimL = new THREE.DirectionalLight(0xff00e5, 0.4);
        rimL.position.set(-5, 0, -5);
        this.scene.add(rimL);

        const rimR = new THREE.DirectionalLight(0x00f0ff, 0.4);
        rimR.position.set(5, 0, -5);
        this.scene.add(rimR);

        this._buildFloor();
        this._buildWalls();
        this._buildCeiling();
        this._buildLaneRails();
        this._buildSpotlights();
    }

    _buildFloor() {
        // Grid texture on offscreen canvas
        const size = 512;
        const offscreen = document.createElement('canvas');
        offscreen.width = offscreen.height = size;
        const ctx = offscreen.getContext('2d');
        ctx.fillStyle = '#0a0820';
        ctx.fillRect(0, 0, size, size);
        ctx.strokeStyle = 'rgba(0,240,255,0.25)';
        ctx.lineWidth = 1;
        const cell = size / 8;
        for (let i = 0; i <= 8; i++) {
            ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, size); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(size, i * cell); ctx.stroke();
        }
        const gridTex = new THREE.CanvasTexture(offscreen);
        gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping;
        gridTex.repeat.set(4, 16);

        const floorGeo = new THREE.PlaneGeometry(12, 40);
        const floorMat = new THREE.MeshStandardMaterial({
            map: gridTex,
            color: 0x180d30,
            roughness: 0.2,
            metalness: 0.8,
        });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(0, -1.8, -12);
        this.scene.add(floor);
    }

    _buildWalls() {
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x0d0a22, roughness: 0.8, metalness: 0.3 });

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
        wallBack.position.set(0, 0.7, -26);
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

        // Plank frame
        const isHostage = kindCfg.hostage;
        const frameColor = isHostage ? 0x005522 : 0x1a1a2e;
        const edgeEmissive = isHostage ? 0x00ff66 : 0x00f0ff;
        const edgeIntensity = isHostage ? 1.0 : 0.6;

        const frameMat = new THREE.MeshStandardMaterial({
            color: frameColor,
            emissive: edgeEmissive,
            emissiveIntensity: edgeIntensity,
            roughness: 0.4,
            metalness: 0.8,
        });

        // Outer frame box
        const frameGeo = new THREE.BoxGeometry(1.3 * s, 1.8 * s, 0.08);
        const frame = new THREE.Mesh(frameGeo, frameMat);
        group.add(frame);

        // Inner image plane (slightly in front of frame)
        const texKey = kindCfg.texKey;
        const tex = this.textures[texKey] || null;
        const imgMat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            alphaTest: 0.1,
            side: THREE.FrontSide,
        });
        const imgGeo = new THREE.PlaneGeometry(1.1 * s, 1.6 * s);
        const img = new THREE.Mesh(imgGeo, imgMat);
        img.position.z = 0.05;
        img.name = 'imagePlane_' + kind;
        group.add(img);

        // Store reference so we can swap texture in later if async
        group.userData.imgMesh = img;
        group.userData.texKey = texKey;

        return group;
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
