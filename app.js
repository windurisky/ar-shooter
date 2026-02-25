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

    let tracker = null;
    let game = null;
    const reloadAnimIds = { Left: null, Right: null };

    // Track per-hand gesture state for status text
    const gestureState = { Left: false, Right: false };

    // ===== Start button =====
    startBtn.addEventListener('click', async () => {
        startBtn.textContent = 'LOADING...';
        startBtn.disabled = true;

        try {
            tracker = new HandTracker();
            game = new Game(canvasEl);
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
        game.start();
        updateAmmoUI('Left', game.maxAmmo, game.maxAmmo);
        updateAmmoUI('Right', game.maxAmmo, game.maxAmmo);
        scoreValue.textContent = '0';
        timerValue.textContent = '60';
        comboValue.textContent = 'x1';
        gestureState.Left = false;
        gestureState.Right = false;
        updateGestureStatus();
    });

    // ===== Wire callbacks =====
    function wireCallbacks() {
        tracker.onAimUpdate = (handId, x, y) => game.updateAim(handId, x, y);
        tracker.onShoot = (handId) => game.shoot(handId);
        tracker.onGestureChange = (handId, isPistol) => {
            gestureState[handId] = isPistol;

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

        game.onScoreUpdate = (s) => {
            scoreValue.textContent = s;
            scoreValue.style.transform = 'scale(1.3)';
            setTimeout(() => scoreValue.style.transform = 'scale(1)', 150);
        };
        game.onTimeUpdate = (t) => {
            timerValue.textContent = t;
            if (t <= 10) timerValue.style.color = '#ff3344';
        };
        game.onComboUpdate = (c) => {
            comboValue.textContent = c > 0 ? `x${c}` : 'x1';
            if (c > 1) {
                comboValue.classList.add('combo-active');
                setTimeout(() => comboValue.classList.remove('combo-active'), 300);
            }
        };
        game.onAmmoUpdate = (handId, current, max) => updateAmmoUI(handId, current, max);
        game.onReloadStart = (handId, duration) => {
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
        };
        game.onReloadEnd = (handId) => {
            const indicator = reloadEls[handId];
            if (!indicator) return;
            indicator.classList.add('hidden');
            if (reloadAnimIds[handId]) cancelAnimationFrame(reloadAnimIds[handId]);
        };
        game.onGameOver = (stats) => {
            hud.classList.add('hidden');
            gameoverScreen.classList.remove('hidden');
            finalScore.textContent = stats.score;
            finalHits.textContent = stats.hits;
            finalAccuracy.textContent = stats.accuracy + '%';
            finalCombo.textContent = 'x' + stats.maxCombo;
            timerValue.style.color = '';
        };
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

    // ===== Keyboard shortcuts =====
    document.addEventListener('keydown', (e) => {
        // C key toggles calibration panel
        if (e.code === 'KeyC' && hud && !hud.classList.contains('hidden')) {
            document.getElementById('calib-panel').classList.toggle('hidden');
            return;
        }
        if (!game || !game.isRunning) return;
        if (e.code === 'Space') {
            e.preventDefault();
            // Space shoots both weapons
            game.shoot('Left');
            game.shoot('Right');
        }
        if (e.code === 'KeyR') {
            // R reloads both weapons
            game._startReload('Left');
            game._startReload('Right');
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
        game.updateAim('Right', e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    });
    canvasEl.addEventListener('click', (e) => {
        if (!game || !game.isRunning) return;
        game.shoot('Right');
    });
})();
