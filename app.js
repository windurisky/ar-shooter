/**
 * App — Wires HandTracker + Game together, manages UI states.
 * Supports dual-hand tracking with independent ammo/reload per hand.
 */
(function () {
    const startScreen = document.getElementById('start-screen');
    const startBtn = document.getElementById('start-btn');
    const hud = document.getElementById('hud');
    const gameoverScreen = document.getElementById('gameover-screen');
    const restartBtn = document.getElementById('restart-btn');
    const scoreValue = document.getElementById('score-value');
    const timerValue = document.getElementById('timer-value');
    const comboValue = document.getElementById('combo-value');
    const gestureStatus = document.getElementById('gesture-status');
    const gestureText = document.getElementById('gesture-text');
    const finalScore = document.getElementById('final-score');
    const finalHits = document.getElementById('final-hits');
    const finalAccuracy = document.getElementById('final-accuracy');
    const finalCombo = document.getElementById('final-combo');

    const videoEl = document.getElementById('camera-feed');
    const canvasEl = document.getElementById('game-canvas');

    // Per-hand UI elements
    const ammoBarEls = {
        Left: document.getElementById('ammo-bar-Left'),
        Right: document.getElementById('ammo-bar-Right'),
    };
    const reloadEls = {
        Left: document.getElementById('reload-indicator-Left'),
        Right: document.getElementById('reload-indicator-Right'),
    };
    const gestureDots = {
        Left: document.getElementById('gesture-dot-Left'),
        Right: document.getElementById('gesture-dot-Right'),
    };

    const gunCanvasEl = document.getElementById('gun-canvas');
    let tracker = null;
    let game = null;
    let gunRenderer = null;
    let mouseGunShown = false;
    const reloadAnimIds = { Left: null, Right: null };

    // ===== Audio =====
    const bgm = new Audio('assets/audio/bgm.mp3');
    bgm.loop = true;
    bgm.volume = 0.4;

    function createAudioPool(src, size, volume) {
        const pool = [];
        for (let i = 0; i < size; i++) {
            const a = new Audio(src);
            a.volume = volume;
            pool.push(a);
        }
        let idx = 0;
        return function play() {
            pool[idx].currentTime = 0;
            pool[idx].play().catch(() => {});
            idx = (idx + 1) % pool.length;
        };
    }

    const playShot = createAudioPool('assets/audio/gun-shot.mp3', 4, 0.6);
    const playReload = createAudioPool('assets/audio/gun-reload.mp3', 2, 0.6);

    // Start BGM on first user interaction (browsers block autoplay without it)
    function startBGM() {
        bgm.play().catch(() => {});
        document.removeEventListener('click', startBGM);
        document.removeEventListener('keydown', startBGM);
    }
    document.addEventListener('click', startBGM);
    document.addEventListener('keydown', startBGM);

    // Track per-hand gesture state for status text
    const gestureState = { Left: false, Right: false };

    // ===== Start button =====
    startBtn.addEventListener('click', async () => {
        startBtn.textContent = 'LOADING...';
        startBtn.disabled = true;

        try {
            tracker = new HandTracker();
            game = new Game(canvasEl);
            gunRenderer = new GunRenderer(gunCanvasEl);
            wireCallbacks();
            await tracker.init(videoEl);

            startScreen.classList.add('hidden');
            hud.classList.remove('hidden');
            game.start();
            updateAmmoUI('Left', game.maxAmmo, game.maxAmmo);
            updateAmmoUI('Right', game.maxAmmo, game.maxAmmo);
        } catch (err) {
            console.error('Failed to start:', err);
            startBtn.textContent = 'CAMERA ERROR — TRY AGAIN';
            startBtn.disabled = false;
        }
    });

    // ===== Restart =====
    restartBtn.addEventListener('click', () => {
        gameoverScreen.classList.add('hidden');
        hud.classList.remove('hidden');
        document.getElementById('hit-markers').innerHTML = '';
        game.start();
        updateAmmoUI('Left', game.maxAmmo, game.maxAmmo);
        updateAmmoUI('Right', game.maxAmmo, game.maxAmmo);
        scoreValue.textContent = '0';
        timerValue.textContent = '60';
        comboValue.textContent = 'x1';
        gestureState.Left = false;
        gestureState.Right = false;
        mouseGunShown = false;
        updateGestureStatus();
    });

    // ===== Wire callbacks =====
    function wireCallbacks() {
        tracker.onAimUpdate = (handId, x, y) => {
            // Feed calibration wizard if active
            if (calibration) {
                collectCalibSample(handId);
                return; // don't update game aim during calibration
            }
            game.updateAim(handId, x, y);
            if (gunRenderer) gunRenderer.updateAim(handId, x, y);
        };
        tracker.onShoot = (handId) => {
            if (calibration) return; // suppress shooting during calibration
            const w = game.weapons[handId];
            if (w && w.isReloading) return;
            game.shoot(handId);
            if (gunRenderer) gunRenderer.triggerRecoil(handId);
            playShot();
        };
        tracker.onGestureChange = (handId, isPistol) => {
            gestureState[handId] = isPistol;

            // Show/hide 3D gun based on gesture
            if (gunRenderer) {
                if (isPistol) gunRenderer.show(handId);
                else gunRenderer.hide(handId);
            }

            // Update per-hand dot
            const dot = gestureDots[handId];
            if (dot) {
                dot.classList.toggle('detected', isPistol);
            }

            if (!isPistol) {
                game.hideCrosshair(handId);
            }

            updateGestureStatus();
        };

        game.on('score', (s) => {
            scoreValue.textContent = s;
            scoreValue.style.transform = 'scale(1.3)';
            setTimeout(() => scoreValue.style.transform = 'scale(1)', 150);
        });
        game.on('time', (t) => {
            timerValue.textContent = t;
            if (t <= 10) timerValue.style.color = '#ff3344';
        });
        game.on('combo', (c) => {
            comboValue.textContent = c > 0 ? `x${c}` : 'x1';
            if (c > 1) {
                comboValue.classList.add('combo-active');
                setTimeout(() => comboValue.classList.remove('combo-active'), 300);
            }
        });
        game.on('ammo', (handId, current, max) => updateAmmoUI(handId, current, max));
        game.on('reloadStart', (handId, duration) => {
            if (gunRenderer) gunRenderer.startReload(handId, duration);
            playReload();
            const indicator = reloadEls[handId];
            if (!indicator) return;
            indicator.classList.remove('hidden');
            const bar = indicator.querySelector('.reload-progress');
            const startTime = Date.now();
            function animReload() {
                const elapsed = Date.now() - startTime;
                const pct = Math.min((elapsed / duration) * 100, 100);
                bar.style.width = pct + '%';
                if (pct < 100) reloadAnimIds[handId] = requestAnimationFrame(animReload);
            }
            animReload();
        });
        game.on('reloadEnd', (handId) => {
            if (gunRenderer) gunRenderer.endReload(handId);
            const indicator = reloadEls[handId];
            if (!indicator) return;
            indicator.classList.add('hidden');
            if (reloadAnimIds[handId]) cancelAnimationFrame(reloadAnimIds[handId]);
        });
        game.on('hit', (x, y, text, isMiss) => {
            const el = document.createElement('div');
            el.className = 'hit-marker' + (isMiss ? ' miss' : '');
            el.textContent = text; el.style.left = x + 'px'; el.style.top = y + 'px';
            document.getElementById('hit-markers').appendChild(el);
            setTimeout(() => el.remove(), 800);
        });
        game.on('gameOver', (stats) => {
            if (gunRenderer) {
                gunRenderer.hide('Left');
                gunRenderer.hide('Right');
            }
            hud.classList.add('hidden');
            gameoverScreen.classList.remove('hidden');
            finalScore.textContent = stats.score;
            finalHits.textContent = stats.hits;
            finalAccuracy.textContent = stats.accuracy + '%';
            finalCombo.textContent = 'x' + stats.maxCombo;
            timerValue.style.color = '';
        });
    }

    function updateAmmoUI(handId, current, max) {
        const bar = ammoBarEls[handId];
        if (!bar) return;
        const bullets = bar.querySelectorAll('.ammo-bullet');
        bullets.forEach((b, i) => {
            b.classList.toggle('active', i < current);
        });
    }

    function updateGestureStatus() {
        const leftOn = gestureState.Left;
        const rightOn = gestureState.Right;

        if (leftOn && rightOn) {
            gestureStatus.classList.add('detected');
            gestureText.textContent = 'Both hands detected — DUAL WIELD!';
        } else if (leftOn || rightOn) {
            gestureStatus.classList.add('detected');
            // MediaPipe "Left" = user's right hand (mirrored)
            const which = leftOn ? 'Right hand' : 'Left hand';
            gestureText.textContent = `${which} detected — AIM & SHOOT!`;
        } else {
            gestureStatus.classList.remove('detected');
            gestureText.textContent = 'Show pistol gesture...';
        }
    }

    // ===== Calibration Wizard =====
    const calibWizard = document.getElementById('calib-wizard');
    const calibTarget = document.getElementById('calib-wizard-target');
    const calibStepNum = document.getElementById('calib-step-num');
    const calibInstruction = document.getElementById('calib-wizard-instruction');
    const calibBar = document.getElementById('calib-wizard-bar');
    const calibHandLabel = document.getElementById('calib-wizard-hand');
    const calibSkipBtn = document.getElementById('calib-wizard-skip');

    let calibration = null; // null = not calibrating

    const CALIB_POINTS = [
        { sx: 0.5, sy: 0.5, label: 'the CENTER' },
        { sx: 0.15, sy: 0.15, label: 'the TOP-LEFT' },
        { sx: 0.85, sy: 0.85, label: 'the BOTTOM-RIGHT' },
    ];
    // Calibrate both hands: each hand goes through all 3 points
    // MediaPipe "Left" = user's right hand (mirrored camera)
    const CALIB_HANDS = [
        { handId: 'Left', userLabel: 'RIGHT HAND', color: 'var(--neon-magenta)' },
        { handId: 'Right', userLabel: 'LEFT HAND', color: 'var(--neon-cyan)' },
    ];
    const CALIB_FRAMES_NEEDED = 50;
    const CALIB_RAY_EXTEND = 1.5;

    function startCalibration() {
        document.getElementById('calib-panel').classList.add('hidden');
        if (game && game.isRunning) game.pause();

        // Set fixed rayExtend for calibration on both hands
        if (tracker) {
            // Clear any per-hand rayExtend so global applies during calibration
            for (const hid of ['Left', 'Right']) {
                const s = tracker._getHandState(hid);
                s.calibRayExtend = CALIB_RAY_EXTEND;
            }
            tracker.rayExtend = CALIB_RAY_EXTEND;
        }

        calibration = {
            handIdx: 0,       // index into CALIB_HANDS
            pointIdx: 0,      // index into CALIB_POINTS
            currentSamples: [],
            results: {},      // handId → { originX, originY, sensitivity }
        };

        calibWizard.classList.remove('hidden');
        calibSkipBtn.classList.remove('hidden');
        showCalibStep();
    }

    function showCalibStep() {
        const hand = CALIB_HANDS[calibration.handIdx];
        const pt = CALIB_POINTS[calibration.pointIdx];
        const totalStep = calibration.handIdx * CALIB_POINTS.length + calibration.pointIdx + 1;
        const totalSteps = CALIB_HANDS.length * CALIB_POINTS.length;

        calibStepNum.textContent = totalStep;
        // Update "of N" in the step label
        calibWizard.querySelector('.calib-wizard-step').textContent =
            'STEP ' + totalStep + ' OF ' + totalSteps;

        calibHandLabel.textContent = hand.userLabel;
        calibHandLabel.style.color = hand.color;
        calibInstruction.textContent = 'Point your ' + hand.userLabel.toLowerCase() + ' at ' + pt.label;

        calibTarget.style.left = (pt.sx * 100) + '%';
        calibTarget.style.top = (pt.sy * 100) + '%';
        calibBar.style.width = '0%';
        calibration.currentSamples = [];
    }

    function collectCalibSample(handId) {
        if (!calibration || !tracker) return;
        // No more hands to calibrate (showing "complete" message)
        if (calibration.handIdx >= CALIB_HANDS.length) return;

        const expectedHand = CALIB_HANDS[calibration.handIdx].handId;
        // Only accept samples from the hand we're currently calibrating
        if (handId !== expectedHand) return;

        const state = tracker.handState[handId];
        if (!state || !state.isPistolGesture) return;

        calibration.currentSamples.push({
            rawX: state.rawAimX,
            rawY: state.rawAimY,
        });

        const pct = Math.min((calibration.currentSamples.length / CALIB_FRAMES_NEEDED) * 100, 100);
        calibBar.style.width = pct + '%';

        if (calibration.currentSamples.length >= CALIB_FRAMES_NEEDED) {
            // Store samples for this point
            const hand = CALIB_HANDS[calibration.handIdx];
            if (!calibration.results[hand.handId]) {
                calibration.results[hand.handId] = { samples: [] };
            }
            calibration.results[hand.handId].samples.push(calibration.currentSamples.slice());

            // Advance to next point or next hand
            calibration.pointIdx++;
            if (calibration.pointIdx < CALIB_POINTS.length) {
                showCalibStep();
            } else {
                // This hand is done — compute its calibration
                computeHandCalibration(hand.handId);
                advanceToNextHand();
            }
        }
    }

    function computeHandCalibration(handId) {
        const data = calibration.results[handId];
        if (!data || data.samples.length < CALIB_POINTS.length) return;

        const avgs = data.samples.map(samples => {
            const sumX = samples.reduce((s, p) => s + p.rawX, 0);
            const sumY = samples.reduce((s, p) => s + p.rawY, 0);
            return { rawX: sumX / samples.length, rawY: sumY / samples.length };
        });

        const originX = avgs[0].rawX;
        const originY = avgs[0].rawY;

        const sensValues = [];
        for (let i = 1; i < CALIB_POINTS.length; i++) {
            const dRawX = avgs[i].rawX - originX;
            const dRawY = avgs[i].rawY - originY;
            const dScreenX = CALIB_POINTS[i].sx - 0.5;
            const dScreenY = CALIB_POINTS[i].sy - 0.5;
            if (Math.abs(dRawX) > 0.01) sensValues.push(dScreenX / dRawX);
            if (Math.abs(dRawY) > 0.01) sensValues.push(dScreenY / dRawY);
        }

        let sensitivity = sensValues.length > 0
            ? sensValues.reduce((a, b) => a + b, 0) / sensValues.length
            : 1.6;
        sensitivity = Math.max(0.8, Math.min(3.0, sensitivity));

        // Apply per-hand calibration
        const state = tracker._getHandState(handId);
        state.calibOriginX = originX;
        state.calibOriginY = originY;
        state.calibSensitivity = sensitivity;
        state.calibRayExtend = CALIB_RAY_EXTEND;

        data.computed = { originX, originY, sensitivity };
    }

    function advanceToNextHand() {
        calibration.handIdx++;
        calibration.pointIdx = 0;

        if (calibration.handIdx < CALIB_HANDS.length) {
            showCalibStep();
        } else {
            finishCalibration();
        }
    }

    function skipCurrentHand() {
        if (!calibration) return;
        // Clear any partial samples for this hand
        const hand = CALIB_HANDS[calibration.handIdx];
        delete calibration.results[hand.handId];
        calibration.pointIdx = 0;
        advanceToNextHand();
    }

    function finishCalibration() {
        // Update sliders to show the last computed values (or first hand's)
        const anyResult = Object.values(calibration.results).find(r => r.computed);
        if (anyResult) {
            updateSlider('ctrl-sensitivity', 'val-sensitivity', anyResult.computed.sensitivity, 1);
            updateSlider('ctrl-ray', 'val-ray', CALIB_RAY_EXTEND, 1);
            updateSlider('ctrl-originy', 'val-originy', anyResult.computed.originY, 2);
        }

        calibInstruction.textContent = 'CALIBRATION COMPLETE!';
        calibHandLabel.textContent = '';
        calibTarget.style.display = 'none';
        calibSkipBtn.classList.add('hidden');
        calibBar.style.width = '100%';

        const calibrated = Object.keys(calibration.results).filter(
            id => calibration.results[id].computed
        );
        const handNames = calibrated.map(id =>
            CALIB_HANDS.find(h => h.handId === id)?.userLabel || id
        );

        const doneEl = document.createElement('div');
        doneEl.className = 'calib-wizard-done';
        doneEl.textContent = handNames.length > 0
            ? 'CALIBRATED: ' + handNames.join(' + ')
            : 'NO HANDS CALIBRATED';
        calibWizard.appendChild(doneEl);

        setTimeout(() => {
            endCalibration();
            doneEl.remove();
            calibTarget.style.display = '';
        }, 1200);
    }

    function endCalibration() {
        calibration = null;
        calibWizard.classList.add('hidden');
        if (game && game.isRunning) game.resume();
    }

    function cancelCalibration() {
        if (calibration && tracker) {
            // Restore any hands that weren't fully calibrated
            for (const hand of CALIB_HANDS) {
                const data = calibration.results[hand.handId];
                if (!data || !data.computed) {
                    const s = tracker._getHandState(hand.handId);
                    s.calibRayExtend = null;
                }
            }
        }
        endCalibration();
    }

    function updateSlider(sliderId, valId, value, decimals) {
        const slider = document.getElementById(sliderId);
        const valEl = document.getElementById(valId);
        if (slider) slider.value = value;
        if (valEl) valEl.textContent = value.toFixed(decimals);
    }

    // Wire up calib panel buttons
    document.getElementById('calib-auto-btn').addEventListener('click', () => {
        if (tracker) startCalibration();
    });
    document.getElementById('calib-advanced-toggle').addEventListener('click', () => {
        document.getElementById('calib-advanced').classList.toggle('hidden');
    });
    document.getElementById('calib-wizard-cancel').addEventListener('click', cancelCalibration);
    calibSkipBtn.addEventListener('click', skipCurrentHand);

    // ===== Keyboard shortcuts =====
    document.addEventListener('keydown', (e) => {
        // ESC cancels calibration wizard
        if (e.code === 'Escape' && calibration) {
            cancelCalibration();
            return;
        }
        // C key toggles calibration panel
        if (e.code === 'KeyC' && hud && !hud.classList.contains('hidden') && !calibration) {
            document.getElementById('calib-panel').classList.toggle('hidden');
            return;
        }
        if (!game || !game.isRunning || game.isPaused) return;
        if (e.code === 'Space') {
            e.preventDefault();
            // Space shoots both weapons
            for (const id of ['Left', 'Right']) {
                const w = game.weapons[id];
                if (w && w.isReloading) continue;
                game.shoot(id);
                playShot();
                if (gunRenderer) gunRenderer.triggerRecoil(id);
            }
        }
        if (e.code === 'KeyR') {
            // R reloads both weapons
            game.reload('Left');
            game.reload('Right');
        }
    });

    // ===== Calibration sliders =====
    function bindSlider(id, valId, prop, decimals = 1) {
        const slider = document.getElementById(id);
        const valEl = document.getElementById(valId);
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            valEl.textContent = v.toFixed(decimals);
            if (tracker) tracker[prop] = v;
        });
    }
    bindSlider('ctrl-sensitivity', 'val-sensitivity', 'sensitivity', 1);
    bindSlider('ctrl-ray', 'val-ray', 'rayExtend', 1);
    bindSlider('ctrl-originy', 'val-originy', 'aimOriginY', 2);
    bindSlider('ctrl-smooth', 'val-smooth', 'smoothingFactor', 2);

    // ===== Mouse fallback for testing (move = aim, click = shoot) =====
    canvasEl.addEventListener('mousemove', (e) => {
        if (!game || !game.isRunning) return;
        const nx = e.clientX / window.innerWidth;
        const ny = e.clientY / window.innerHeight;
        game.updateAim('Right', nx, ny);
        if (gunRenderer) {
            if (!mouseGunShown) { gunRenderer.show('Right'); mouseGunShown = true; }
            gunRenderer.updateAim('Right', nx, ny);
        }
    });
    canvasEl.addEventListener('click', (e) => {
        if (!game || !game.isRunning) return;
        const w = game.weapons['Right'];
        if (w && w.isReloading) return;
        game.shoot('Right');
        if (gunRenderer) gunRenderer.triggerRecoil('Right');
        playShot();
    });
})();
