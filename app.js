/**
 * HyperMiler — live vehicle forces + trip smoothness score.
 * Portrait fixed mount. Motion sensors + GPS speed.
 * No manual Zero: linear accel when available, else continuous gravity LP.
 */
(function () {
  "use strict";

  const G = 9.80665;
  const BAR_MAX_G = 0.55;
  const SMOOTH_ALPHA = 0.18;
  /** Slow gravity tracker when OS only gives accel+gravity (no user Zero). */
  const GRAV_ALPHA = 0.025;
  const HARSH_LONG_G = 0.22;
  const HARSH_CORNER_G = 0.28;
  const HARSH_COOLDOWN_MS = 1200;
  const SCORE_HARSH_PENALTY = 4;
  const SCORE_RMS_WEIGHT = 85;
  const USE_MPH = true;

  const el = {
    speed: document.getElementById("speed"),
    speedUnit: document.getElementById("speed-unit"),
    valAccel: document.getElementById("val-accel"),
    valBrake: document.getElementById("val-brake"),
    valCorner: document.getElementById("val-corner"),
    barAccel: document.getElementById("bar-accel"),
    barBrake: document.getElementById("bar-brake"),
    barCorner: document.getElementById("bar-corner"),
    score: document.getElementById("score"),
    scoreRing: document.getElementById("score-ring"),
    dist: document.getElementById("dist"),
    time: document.getElementById("time"),
    peak: document.getElementById("peak"),
    harsh: document.getElementById("harsh"),
    hint: document.getElementById("hint"),
    pillMotion: document.getElementById("pill-motion"),
    pillGps: document.getElementById("pill-gps"),
    btnStart: document.getElementById("btn-start"),
    btnReset: document.getElementById("btn-reset"),
  };

  el.speedUnit.textContent = USE_MPH ? "mph" : "km/h";

  const state = {
    running: false,
    motionOn: false,
    gpsOn: false,
    grav: null,
    smooth: { long: 0, lat: 0 },
    speedMps: null,
    lastGps: null,
    tripStartedAt: 0,
    distanceM: 0,
    peakG: 0,
    harshCount: 0,
    lastHarshAt: 0,
    sampleN: 0,
    sumSq: 0,
    wakeLock: null,
    geoWatchId: null,
    motionHandler: null,
    raf: 0,
    lastUi: { a: -1, b: -1, c: -1, score: -1 },
  };

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function formatG(g) {
    return `${g.toFixed(2)}g`;
  }

  function formatSpeed(mps) {
    if (mps == null || !Number.isFinite(mps) || mps < 0) return "—";
    const v = USE_MPH ? mps * 2.236936 : mps * 3.6;
    return Math.round(v).toString();
  }

  function formatDist(m) {
    if (USE_MPH) {
      const mi = m / 1609.344;
      return `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
    }
    const km = m / 1000;
    return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  function setPill(node, text, mode) {
    node.textContent = text;
    node.classList.remove("on", "warn");
    if (mode === "on") node.classList.add("on");
    if (mode === "warn") node.classList.add("warn");
  }

  function toneForG(g) {
    if (g < 0.12) return "tone-green";
    if (g < 0.25) return "tone-amber";
    return "tone-red";
  }

  function barColor(g) {
    if (g < 0.12) return "var(--green)";
    if (g < 0.25) return "var(--amber)";
    return "var(--red)";
  }

  function tripScore() {
    if (state.sampleN < 8) return 100;
    const rms = Math.sqrt(state.sumSq / state.sampleN);
    const rmsPenalty = clamp(rms * SCORE_RMS_WEIGHT, 0, 55);
    const harshPenalty = Math.min(40, state.harshCount * SCORE_HARSH_PENALTY);
    return Math.round(clamp(100 - rmsPenalty - harshPenalty, 0, 100));
  }

  function scoreTone(score) {
    if (score >= 85) return "var(--green)";
    if (score >= 65) return "var(--amber)";
    return "var(--red)";
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLon = (lon2 - lon1) * toR;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * Portrait, screen toward cabin: +X right, +Y up, +Z toward driver.
   * Forward vehicle accel → −Z. Positive long = accelerate, negative = brake.
   */
  function phoneToVehicle(ax, ay, az) {
    return {
      longG: -az / G,
      latG: ax / G,
      vertG: ay / G,
    };
  }

  function readLinearAccel(event) {
    const a = event.acceleration;
    const ag = event.accelerationIncludingGravity;

    // Prefer OS linear accel (gravity already removed).
    if (a && a.x != null && a.y != null && a.z != null) {
      return { x: a.x, y: a.y, z: a.z };
    }

    // Fallback: track gravity slowly and subtract.
    if (ag && ag.x != null && ag.y != null && ag.z != null) {
      if (!state.grav) {
        state.grav = { x: ag.x, y: ag.y, z: ag.z };
      } else {
        state.grav.x += GRAV_ALPHA * (ag.x - state.grav.x);
        state.grav.y += GRAV_ALPHA * (ag.y - state.grav.y);
        state.grav.z += GRAV_ALPHA * (ag.z - state.grav.z);
      }
      return {
        x: ag.x - state.grav.x,
        y: ag.y - state.grav.y,
        z: ag.z - state.grav.z,
      };
    }

    return null;
  }

  function onMotion(event) {
    if (!state.running) return;
    const raw = readLinearAccel(event);
    if (!raw) return;

    const { longG, latG } = phoneToVehicle(raw.x, raw.y, raw.z);

    state.smooth.long += SMOOTH_ALPHA * (longG - state.smooth.long);
    state.smooth.lat += SMOOTH_ALPHA * (latG - state.smooth.lat);

    const long = state.smooth.long;
    const lat = state.smooth.lat;
    const mag = Math.hypot(long, lat);

    state.sampleN += 1;
    state.sumSq += mag * mag;
    if (mag > state.peakG) state.peakG = mag;

    const now = performance.now();
    const harshLong = Math.abs(long) >= HARSH_LONG_G;
    const harshLat = Math.abs(lat) >= HARSH_CORNER_G;
    if ((harshLong || harshLat) && now - state.lastHarshAt > HARSH_COOLDOWN_MS) {
      const moving = state.speedMps == null || state.speedMps > 1.2;
      if (moving) {
        state.harshCount += 1;
        state.lastHarshAt = now;
      }
    }
  }

  function paint() {
    const long = state.smooth.long;
    const lat = state.smooth.lat;
    const accel = Math.max(0, long);
    const brake = Math.max(0, -long);
    const corner = Math.abs(lat);

    const aKey = Math.round(accel * 100);
    const bKey = Math.round(brake * 100);
    const cKey = Math.round(corner * 100);

    if (aKey !== state.lastUi.a) {
      el.valAccel.textContent = formatG(accel);
      el.valAccel.className = `g-value ${toneForG(accel)}`;
      el.barAccel.style.height = `${clamp((accel / BAR_MAX_G) * 100, 0, 100)}%`;
      el.barAccel.style.background = barColor(accel);
      state.lastUi.a = aKey;
    }
    if (bKey !== state.lastUi.b) {
      el.valBrake.textContent = formatG(brake);
      el.valBrake.className = `g-value ${toneForG(brake)}`;
      el.barBrake.style.height = `${clamp((brake / BAR_MAX_G) * 100, 0, 100)}%`;
      el.barBrake.style.background = barColor(brake);
      state.lastUi.b = bKey;
    }
    if (cKey !== state.lastUi.c) {
      el.valCorner.textContent = formatG(corner);
      el.valCorner.className = `g-value ${toneForG(corner)}`;
      el.barCorner.style.height = `${clamp((corner / BAR_MAX_G) * 100, 0, 100)}%`;
      el.barCorner.style.background = barColor(corner);
      state.lastUi.c = cKey;
    }

    el.speed.textContent = formatSpeed(state.speedMps);

    if (state.running && state.tripStartedAt) {
      el.time.textContent = formatTime(Date.now() - state.tripStartedAt);
    }
    el.dist.textContent = formatDist(state.distanceM);
    el.peak.textContent = state.peakG.toFixed(2);
    el.harsh.textContent = String(state.harshCount);

    const score = tripScore();
    if (score !== state.lastUi.score) {
      el.score.textContent = String(score);
      el.scoreRing.style.setProperty("--score-deg", `${(score / 100) * 360}deg`);
      el.scoreRing.style.background = `radial-gradient(circle at center, var(--surface) 58%, transparent 59%), conic-gradient(${scoreTone(score)} var(--score-deg), var(--surface-2) 0)`;
      state.lastUi.score = score;
    }

    state.raf = requestAnimationFrame(paint);
  }

  function setHint(html) {
    el.hint.innerHTML = html;
  }

  async function requestMotionPermission() {
    const DOM = window.DeviceMotionEvent;
    if (!DOM) {
      setHint("This browser has no motion sensors.");
      return false;
    }
    if (typeof DOM.requestPermission === "function") {
      try {
        const res = await DOM.requestPermission();
        if (res !== "granted") {
          setHint("Motion permission denied. Enable motion for this site in Settings.");
          return false;
        }
      } catch (_) {
        setHint("Could not request motion permission. Try again from a user tap.");
        return false;
      }
    }
    return true;
  }

  function startMotion() {
    if (state.motionHandler) return true;
    state.motionHandler = onMotion;
    window.addEventListener("devicemotion", state.motionHandler, { passive: true });
    state.motionOn = true;
    setPill(el.pillMotion, "Motion on", "on");
    return true;
  }

  function stopMotion() {
    if (state.motionHandler) {
      window.removeEventListener("devicemotion", state.motionHandler);
      state.motionHandler = null;
    }
    state.motionOn = false;
    setPill(el.pillMotion, "Motion off", null);
  }

  function startGps() {
    if (!navigator.geolocation) {
      setPill(el.pillGps, "GPS n/a", "warn");
      return;
    }
    if (state.geoWatchId != null) return;

    state.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.gpsOn = true;
        setPill(el.pillGps, "GPS on", "on");

        const { latitude, longitude, speed, accuracy } = pos.coords;
        const t = pos.timestamp;

        if (speed != null && Number.isFinite(speed) && speed >= 0) {
          state.speedMps = speed;
        }

        if (state.running && state.lastGps) {
          const dt = (t - state.lastGps.t) / 1000;
          if (dt > 0 && dt < 8 && accuracy != null && accuracy < 45) {
            const d = haversineM(
              state.lastGps.lat,
              state.lastGps.lon,
              latitude,
              longitude
            );
            if (d < 80 && (state.speedMps == null || state.speedMps > 0.8)) {
              state.distanceM += d;
            }
          }
        }

        state.lastGps = { lat: latitude, lon: longitude, t };
      },
      (err) => {
        state.gpsOn = false;
        setPill(el.pillGps, "GPS off", "warn");
        if (err.code === 1) {
          setHint("Location denied. Allow location for speed & distance.");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 12000,
      }
    );
  }

  function stopGps() {
    if (state.geoWatchId != null) {
      navigator.geolocation.clearWatch(state.geoWatchId);
      state.geoWatchId = null;
    }
    state.gpsOn = false;
    state.speedMps = null;
    state.lastGps = null;
    setPill(el.pillGps, "GPS off", null);
  }

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock?.request) {
        state.wakeLock = await navigator.wakeLock.request("screen");
        state.wakeLock.addEventListener("release", () => {
          state.wakeLock = null;
        });
      }
    } catch (_) {
      /* optional */
    }
  }

  async function releaseWakeLock() {
    try {
      await state.wakeLock?.release();
    } catch (_) {}
    state.wakeLock = null;
  }

  function resetTripStats() {
    state.tripStartedAt = Date.now();
    state.distanceM = 0;
    state.peakG = 0;
    state.harshCount = 0;
    state.lastHarshAt = 0;
    state.sampleN = 0;
    state.sumSq = 0;
    state.smooth.long = 0;
    state.smooth.lat = 0;
    state.grav = null;
    state.lastUi.score = -1;
  }

  async function startSession() {
    const ok = await requestMotionPermission();
    if (!ok) return;

    startMotion();
    startGps();
    await requestWakeLock();

    state.running = true;
    resetTripStats();

    el.btnStart.textContent = "Stop";
    el.btnStart.classList.add("running");
    el.btnReset.disabled = false;

    setHint("Trip running. Keep phone <strong>fixed · portrait</strong> — no taps needed.");
  }

  async function stopSession() {
    state.running = false;
    stopMotion();
    stopGps();
    await releaseWakeLock();

    el.btnStart.textContent = "Start";
    el.btnStart.classList.remove("running");
    el.btnReset.disabled = false;

    setHint(
      `Trip paused. Score <strong>${tripScore()}</strong> · peak <strong>${state.peakG.toFixed(2)}g</strong> · harsh <strong>${state.harshCount}</strong>.`
    );
  }

  async function toggleStart() {
    if (state.running) await stopSession();
    else await startSession();
  }

  function resetAll() {
    resetTripStats();
    if (state.running) {
      setHint("Trip reset. Drive on — no zeroing.");
    } else {
      setHint("Mount phone <strong>fixed · portrait</strong>, then Start. Drive hands-off.");
    }
  }

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.running) {
      await requestWakeLock();
    }
  });

  el.btnStart.addEventListener("click", () => {
    toggleStart();
  });
  el.btnReset.addEventListener("click", () => {
    resetAll();
  });

  const fit = window.FitToScreen.create({
    stage: "fit-stage",
    app: "app",
    phoneMaxWidth: 767,
    wideAppWidth: 380,
    capScaleAtOne: true,
  });
  fit.bindViewportListeners();
  fit.bootLayout();

  paint();
})();
