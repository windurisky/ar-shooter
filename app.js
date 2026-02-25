/**
 * App — Wires HandTracker + Game together, manages UI states.
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
    const ammoBar = document.getElementById('ammo-bar');
    const reloadIndicator = document.getElementById('reload-indicator');
    const gestureStatus = document.getElementById('gesture-status');
    const gestureText = document.getElementById('gesture-text');
    const finalScore = document.getElementById('final-score');
    const finalHits = document.getElementById('final-hits');
    const finalAccuracy = document.getElementById('final-accuracy');
    const finalCombo = document.getElementById('final-combo');

    const videoEl = document.getElementById('camera-feed');
    const canvasEl = document.getElementById('game-canvas');

    let tracker = null;
    let game = null;
    let reloadAnimId = null;

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
            updateAmmoUI(game.ammo, game.maxAmmo);
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
        updateAmmoUI(game.ammo, game.maxAmmo);
        scoreValue.textContent = '0';
        timerValue.textContent = '60';
        comboValue.textContent = 'x1';
    });

    // ===== Wire callbacks =====
    function wireCallbacks() {
        tracker.onAimUpdate = (x, y) => game.updateAim(x, y);
        tracker.onShoot = () => game.shoot();
        tracker.onGestureChange = (isPistol) => {
            if (isPistol) {
                gestureStatus.classList.add('detected');
                gestureText.textContent = '🔫 Pistol detected — AIM & SHOOT!';
            } else {
                gestureStatus.classList.remove('detected');
                gestureText.textContent = 'Show pistol gesture...';
                game.hideCrosshair();
            }
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
        game.onAmmoUpdate = (current, max) => updateAmmoUI(current, max);
        game.onReloadStart = (duration) => {
            reloadIndicator.classList.remove('hidden');
            const bar = reloadIndicator.querySelector('.reload-progress');
            const startTime = Date.now();
            function animReload() {
                const elapsed = Date.now() - startTime;
                const pct = Math.min((elapsed / duration) * 100, 100);
                bar.style.width = pct + '%';
                if (pct < 100) reloadAnimId = requestAnimationFrame(animReload);
            }
            animReload();
        };
        game.onReloadEnd = () => {
            reloadIndicator.classList.add('hidden');
            if (reloadAnimId) cancelAnimationFrame(reloadAnimId);
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

    function updateAmmoUI(current, max) {
        const bullets = ammoBar.querySelectorAll('.ammo-bullet');
        bullets.forEach((b, i) => {
            b.classList.toggle('active', i < current);
        });
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
            game.shoot();
        }
        if (e.code === 'KeyR') game._startReload();
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
        game.updateAim(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    });
    canvasEl.addEventListener('click', (e) => {
        if (!game || !game.isRunning) return;
        game.shoot();
    });
})();

