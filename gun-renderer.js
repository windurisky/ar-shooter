/**
 * GunRenderer — 3D FPS-style gun overlay using Three.js.
 * Renders left/right procedural pistol models at the bottom of the screen,
 * with smooth show/hide, recoil, idle sway, and reload animations.
 */
class GunRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.width = window.innerWidth;
        this.height = window.innerHeight;

        // Three.js setup
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, this.width / this.height, 0.1, 100);
        this.camera.position.set(0, 0.15, 0);
        this.camera.rotation.x = -0.08; // Slight downward tilt to see the guns

        this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 0);

        // Lighting
        const ambient = new THREE.AmbientLight(0x404060, 0.8);
        this.scene.add(ambient);

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
        keyLight.position.set(2, 3, 4);
        this.scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0x4488ff, 0.4);
        fillLight.position.set(-2, 1, 2);
        this.scene.add(fillLight);

        const rimLight = new THREE.DirectionalLight(0x00f0ff, 0.3);
        rimLight.position.set(0, -1, -2);
        this.scene.add(rimLight);

        // Per-hand gun state
        // MediaPipe "Left" = user's right hand → gun on RIGHT side of screen
        // MediaPipe "Right" = user's left hand → gun on LEFT side of screen
        this.guns = {
            Left: this._createGunState('Left'),   // user's right hand → right side
            Right: this._createGunState('Right'),  // user's left hand → left side
        };

        this._buildGunModel('Left');
        this._buildGunModel('Right');

        this._onResize = () => this._handleResize();
        window.addEventListener('resize', this._onResize);

        this._animate = this._animate.bind(this);
        this._startTime = Date.now();
        this._animate();

    }

    _createGunState(handId) {
        return {
            visible: false,
            group: null,
            // Animation progress: 0 = fully hidden, 1 = fully shown
            showProgress: 0,
            targetShow: 0,
            // Recoil
            recoilAmount: 0,
            // Muzzle flash
            muzzleFlashTime: 0,
            // Reload
            isReloading: false,
            reloadProgress: 0,
            reloadDuration: 1500,
            reloadStartTime: 0,
            // Aim position (normalized 0-1)
            aimX: 0.5,
            aimY: 0.5,
            smoothAimX: 0.5,
            smoothAimY: 0.5,
        };
    }

    _buildGunModel(handId) {
        const state = this.guns[handId];
        const group = new THREE.Group();

        const gunColor = 0x2a2a35;
        const accentColor = handId === 'Left' ? 0xff00e5 : 0x00f0ff;

        const bodyMat = new THREE.MeshStandardMaterial({
            color: gunColor, roughness: 0.3, metalness: 0.8,
        });
        const accentMat = new THREE.MeshStandardMaterial({
            color: accentColor, roughness: 0.2, metalness: 0.9,
            emissive: accentColor, emissiveIntensity: 0.3,
        });
        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x1a1a22, roughness: 0.5, metalness: 0.7,
        });
        const gripMat = new THREE.MeshStandardMaterial({
            color: 0x1a1a1a, roughness: 0.8, metalness: 0.2,
        });

        // === Slide (top part of the pistol) ===
        const slideGeo = new THREE.BoxGeometry(0.12, 0.1, 0.55);
        const slide = new THREE.Mesh(slideGeo, bodyMat);
        slide.position.set(0, 0.06, -0.05);
        group.add(slide);

        // Slide top bevel
        const slideTopGeo = new THREE.BoxGeometry(0.10, 0.02, 0.52);
        const slideTop = new THREE.Mesh(slideTopGeo, darkMat);
        slideTop.position.set(0, 0.12, -0.04);
        group.add(slideTop);

        // === Barrel ===
        const barrelGeo = new THREE.CylinderGeometry(0.025, 0.028, 0.18, 8);
        const barrel = new THREE.Mesh(barrelGeo, darkMat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.06, -0.38);
        group.add(barrel);

        // Muzzle ring
        const muzzleGeo = new THREE.TorusGeometry(0.032, 0.006, 8, 16);
        const muzzle = new THREE.Mesh(muzzleGeo, accentMat);
        muzzle.position.set(0, 0.06, -0.46);
        group.add(muzzle);

        // === Muzzle flash ===
        const flashGroup = new THREE.Group();
        flashGroup.position.set(0, 0.06, -0.50);
        flashGroup.name = 'muzzleFlash';
        flashGroup.visible = false;

        // Core flash glow (sphere)
        const flashCoreMat = new THREE.MeshBasicMaterial({
            color: 0xffffaa, transparent: true, opacity: 1.0,
        });
        const flashCore = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), flashCoreMat);
        flashCore.name = 'flashCore';
        flashGroup.add(flashCore);

        // Outer flash glow (larger, more transparent)
        const flashOuterMat = new THREE.MeshBasicMaterial({
            color: 0xff8833, transparent: true, opacity: 0.6,
        });
        const flashOuter = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), flashOuterMat);
        flashOuter.name = 'flashOuter';
        flashGroup.add(flashOuter);

        // Flash streaks (elongated along barrel axis)
        const streakMat = new THREE.MeshBasicMaterial({
            color: 0xffdd44, transparent: true, opacity: 0.7,
        });
        const streakGeo = new THREE.CylinderGeometry(0.008, 0.002, 0.15, 4);
        for (let i = 0; i < 4; i++) {
            const streak = new THREE.Mesh(streakGeo, streakMat.clone());
            const angle = (Math.PI * 2 * i) / 4 + Math.PI / 4;
            streak.rotation.x = Math.PI / 2;
            streak.rotation.z = angle;
            streak.position.z = -0.06;
            streak.position.x = Math.cos(angle) * 0.015;
            streak.position.y = Math.sin(angle) * 0.015;
            streak.name = 'streak' + i;
            flashGroup.add(streak);
        }

        // Point light for muzzle illumination
        const flashLight = new THREE.PointLight(0xffaa44, 0, 0.8);
        flashLight.name = 'flashLight';
        flashGroup.add(flashLight);

        group.add(flashGroup);

        // === Frame (lower body) ===
        const frameGeo = new THREE.BoxGeometry(0.10, 0.06, 0.40);
        const frame = new THREE.Mesh(frameGeo, bodyMat);
        frame.position.set(0, -0.01, 0.02);
        group.add(frame);

        // Trigger guard
        const guardShape = new THREE.Shape();
        guardShape.moveTo(0, 0);
        guardShape.lineTo(0.08, 0);
        guardShape.lineTo(0.08, -0.06);
        guardShape.quadraticCurveTo(0.04, -0.09, 0, -0.06);
        guardShape.lineTo(0, 0);
        const guardGeo = new THREE.ExtrudeGeometry(guardShape, {
            depth: 0.015, bevelEnabled: false,
        });
        const guard = new THREE.Mesh(guardGeo, bodyMat);
        guard.position.set(-0.04, -0.03, -0.05);
        guard.rotation.y = 0;
        group.add(guard);

        // Trigger
        const triggerGeo = new THREE.BoxGeometry(0.015, 0.04, 0.01);
        const trigger = new THREE.Mesh(triggerGeo, accentMat);
        trigger.position.set(0, -0.05, -0.06);
        group.add(trigger);

        // === Grip ===
        const gripGeo = new THREE.BoxGeometry(0.09, 0.22, 0.12);
        const grip = new THREE.Mesh(gripGeo, gripMat);
        grip.position.set(0, -0.14, 0.1);
        grip.rotation.x = -0.15;
        group.add(grip);

        // Grip texture lines
        for (let i = 0; i < 6; i++) {
            const lineGeo = new THREE.BoxGeometry(0.092, 0.004, 0.005);
            const line = new THREE.Mesh(lineGeo, darkMat);
            line.position.set(0, -0.07 - i * 0.025, 0.04 + i * -0.004);
            line.rotation.x = -0.15;
            group.add(line);
        }

        // === Magazine base ===
        const magGeo = new THREE.BoxGeometry(0.07, 0.03, 0.09);
        const mag = new THREE.Mesh(magGeo, darkMat);
        mag.position.set(0, -0.26, 0.09);
        mag.name = 'magazine';
        group.add(mag);

        // === Accent strips (neon lines) ===
        const stripGeo = new THREE.BoxGeometry(0.005, 0.005, 0.35);
        const stripL = new THREE.Mesh(stripGeo, accentMat);
        stripL.position.set(-0.062, 0.03, -0.02);
        group.add(stripL);
        const stripR = new THREE.Mesh(stripGeo, accentMat);
        stripR.position.set(0.062, 0.03, -0.02);
        group.add(stripR);

        // === Rear sight ===
        const rearSightGeo = new THREE.BoxGeometry(0.08, 0.03, 0.015);
        const rearSight = new THREE.Mesh(rearSightGeo, darkMat);
        rearSight.position.set(0, 0.13, 0.19);
        group.add(rearSight);

        // Rear sight notch dots
        const dotGeo = new THREE.SphereGeometry(0.005, 6, 6);
        const dotL = new THREE.Mesh(dotGeo, accentMat);
        dotL.position.set(-0.025, 0.145, 0.19);
        group.add(dotL);
        const dotR = new THREE.Mesh(dotGeo, accentMat);
        dotR.position.set(0.025, 0.145, 0.19);
        group.add(dotR);

        // === Front sight ===
        const frontSightGeo = new THREE.BoxGeometry(0.02, 0.025, 0.015);
        const frontSight = new THREE.Mesh(frontSightGeo, darkMat);
        frontSight.position.set(0, 0.125, -0.26);
        group.add(frontSight);
        const frontDot = new THREE.Mesh(dotGeo, accentMat);
        frontDot.position.set(0, 0.14, -0.26);
        group.add(frontDot);

        // === Hammer ===
        const hammerGeo = new THREE.BoxGeometry(0.025, 0.04, 0.02);
        const hammer = new THREE.Mesh(hammerGeo, bodyMat);
        hammer.position.set(0, 0.1, 0.23);
        hammer.rotation.x = -0.3;
        group.add(hammer);

        // Position & orient the entire gun group
        // Right side for Left hand (user's right), left side for Right hand (user's left)
        const side = handId === 'Right' ? -1 : 1; // screen side
        const xPos = side * 0.35;
        group.position.set(xPos, -0.25, -0.7);
        group.rotation.set(-0.15, side * -0.2, side * 0.05);

        // Start hidden (below screen)
        group.position.y = -1.2;

        state.group = group;
        state.restPos = { x: xPos, y: -0.25, z: -0.7 };
        state.hiddenPos = { x: xPos, y: -1.2, z: -0.7 };
        state.side = side;

        // Cache child references to avoid getObjectByName per frame
        state.muzzleFlash = flashGroup;
        state.flashCore = flashGroup.getObjectByName('flashCore');
        state.flashOuter = flashGroup.getObjectByName('flashOuter');
        state.flashStreaks = [];
        for (let i = 0; i < 4; i++) {
            state.flashStreaks.push(flashGroup.getObjectByName('streak' + i));
        }
        state.flashLight = flashGroup.getObjectByName('flashLight');
        state.magazine = mag;

        this.scene.add(group);
    }

    // --- Public API ---

    show(handId) {
        const state = this.guns[handId];
        if (state) {
            state.targetShow = 1;
        }
    }

    hide(handId) {
        const state = this.guns[handId];
        if (state) state.targetShow = 0;
    }

    triggerRecoil(handId) {
        const state = this.guns[handId];
        if (state) {
            state.recoilAmount = 1.0;
            state.muzzleFlashTime = 1.0;
        }
    }

    startReload(handId, duration) {
        const state = this.guns[handId];
        if (!state) return;
        state.isReloading = true;
        state.reloadProgress = 0;
        state.reloadDuration = duration;
        state.reloadStartTime = Date.now();
    }

    endReload(handId) {
        const state = this.guns[handId];
        if (state) state.isReloading = false;
    }

    updateAim(handId, normX, normY) {
        const state = this.guns[handId];
        if (state) {
            state.aimX = normX;
            state.aimY = normY;
        }
    }

    // --- Animation Loop ---

    _animate() {
        this._animFrameId = requestAnimationFrame(this._animate);
        const t = (Date.now() - this._startTime) / 1000;

        for (const [handId, state] of Object.entries(this.guns)) {
            if (!state.group) continue;
            this._updateGun(handId, state, t);
        }

        this.renderer.render(this.scene, this.camera);
    }

    _updateGun(handId, state, t) {
        const group = state.group;

        // --- Show/hide spring animation ---
        const showSpeed = 0.08;
        state.showProgress += (state.targetShow - state.showProgress) * showSpeed;
        // Snap to target when very close
        if (Math.abs(state.targetShow - state.showProgress) < 0.001) {
            state.showProgress = state.targetShow;
        }

        const eased = this._easeOutBack(state.showProgress);

        // Interpolate between hidden and rest position
        const restY = state.restPos.y;
        const hiddenY = state.hiddenPos.y;
        const baseY = hiddenY + (restY - hiddenY) * eased;

        // --- Smooth aim tracking (subtle gun tilt following crosshair) ---
        state.smoothAimX += (state.aimX - state.smoothAimX) * 0.06;
        state.smoothAimY += (state.aimY - state.smoothAimY) * 0.06;

        const aimOffsetX = (state.smoothAimX - 0.5) * 0.08;
        const aimOffsetY = (0.5 - state.smoothAimY) * 0.06;
        const aimRotX = (state.smoothAimY - 0.5) * 0.12;
        const aimRotY = (state.smoothAimX - 0.5) * -0.15;

        // --- Idle sway (subtle breathing motion) ---
        const swayX = Math.sin(t * 1.2) * 0.008;
        const swayY = Math.cos(t * 0.9) * 0.005 + Math.sin(t * 1.8) * 0.003;
        const swayRotZ = Math.sin(t * 0.7) * 0.008;

        // --- Recoil ---
        let recoilY = 0, recoilZ = 0, recoilRotX = 0;
        if (state.recoilAmount > 0.01) {
            // Sharp kick: muzzle rises (positive rotX), gun pushes back
            recoilY = state.recoilAmount * 0.04;
            recoilZ = state.recoilAmount * 0.08;
            recoilRotX = state.recoilAmount * 0.25;
            state.recoilAmount *= 0.82; // Fast decay
            if (state.recoilAmount < 0.01) state.recoilAmount = 0;
        }

        // --- Reload animation ---
        let reloadRotX = 0, reloadRotZ = 0, reloadY = 0;
        let magOffsetY = 0;
        if (state.isReloading) {
            const elapsed = Date.now() - state.reloadStartTime;
            state.reloadProgress = Math.min(elapsed / state.reloadDuration, 1);
            const p = state.reloadProgress;

            if (p < 0.25) {
                // Phase 1: Tilt gun up to eject magazine
                const t1 = p / 0.25;
                const e1 = this._easeOutCubic(t1);
                reloadRotX = e1 * -0.5;
                reloadRotZ = e1 * 0.15 * state.side;
                magOffsetY = e1 * -0.25;
            } else if (p < 0.5) {
                // Phase 2: Magazine falls away
                const t2 = (p - 0.25) / 0.25;
                reloadRotX = -0.5;
                reloadRotZ = 0.15 * state.side;
                magOffsetY = -0.25 - t2 * 0.5;
            } else if (p < 0.75) {
                // Phase 3: New magazine comes in
                const t3 = (p - 0.5) / 0.25;
                const e3 = this._easeOutCubic(t3);
                reloadRotX = -0.5 + e3 * 0.3;
                reloadRotZ = (0.15 - e3 * 0.1) * state.side;
                magOffsetY = (-0.75 + e3 * 0.75);
            } else {
                // Phase 4: Rack slide — return to normal
                const t4 = (p - 0.75) / 0.25;
                const e4 = this._easeOutBack(t4);
                reloadRotX = -0.2 * (1 - e4);
                reloadRotZ = 0.05 * (1 - e4) * state.side;
                reloadY = Math.sin(t4 * Math.PI) * 0.02;
                magOffsetY = 0;
            }
        }

        // --- Muzzle flash (using cached refs) ---
        const flash = state.muzzleFlash;
        if (flash) {
            if (state.muzzleFlashTime > 0.01) {
                flash.visible = true;
                const f = state.muzzleFlashTime;
                const scale = 0.5 + f * 1.5;
                flash.scale.set(scale, scale, scale);
                flash.rotation.z = Math.random() * Math.PI * 2;
                if (state.flashCore) state.flashCore.material.opacity = f;
                if (state.flashOuter) state.flashOuter.material.opacity = f * 0.6;
                for (let i = 0; i < state.flashStreaks.length; i++) {
                    if (state.flashStreaks[i]) state.flashStreaks[i].material.opacity = f * 0.7;
                }
                if (state.flashLight) state.flashLight.intensity = f * 3;
                state.muzzleFlashTime *= 0.65;
                if (state.muzzleFlashTime < 0.01) state.muzzleFlashTime = 0;
            } else {
                flash.visible = false;
            }
        }

        // Update magazine position (using cached ref)
        const mag = state.magazine;
        if (mag) {
            mag.position.y = -0.26 + magOffsetY;
            mag.visible = !(state.isReloading && state.reloadProgress > 0.3 && state.reloadProgress < 0.55);
        }

        // Compose final position
        group.position.x = state.restPos.x + aimOffsetX + swayX;
        group.position.y = baseY + aimOffsetY + swayY + recoilY + reloadY;
        group.position.z = state.restPos.z + recoilZ;

        // Compose final rotation
        group.rotation.x = aimRotX + recoilRotX + reloadRotX;
        group.rotation.y = state.side * -0.1 + aimRotY;
        group.rotation.z = swayRotZ + reloadRotZ;
    }

    // --- Easing functions ---

    _easeOutBack(t) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }

    _easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    // --- Resize ---

    _handleResize() {
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.width, this.height);
    }

    destroy() {
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        window.removeEventListener('resize', this._onResize);
        this.renderer.dispose();
    }
}
