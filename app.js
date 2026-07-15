/**
 * HyperMiler — live forces + bumps + smoothness (policy A).
 * Auto orientation · handheld gate (scoring) · score only while moving · dual peak holds while recording.
 */
(function () {
  "use strict";

  const G = 9.80665;
  const BAR_MAX_G = 0.5; // TEMP test — restore to 1.0 after meter-action check
  const SMOOTH_ALPHA = 0.2;
  /** Display-only second pass — high α keeps bars close to motion; lower = calmer. Scoring ignores this. */
  const DISPLAY_ALPHA = 0.15;
  const GRAV_ALPHA = 0.04;
  const FWD_BLEND = 0.08;
  const MOVE_MPS = 1.2; // ~2.7 mph
  const HANDHELD_HOLD_MS = 1600;
  const GRAV_TILT_HANDHELD = 0.12; // ~7° change in unit grav · per sample blend
  const BUMP_G = 0.32;
  const BUMP_DOMINANCE = 1.15; // |vert| must beat long/lat
  const BUMP_COOLDOWN_MS = 900;
  const SCORE_RMS_WEIGHT = 85;
  const RECENT_HOLD_MS = 1100;
  const RECENT_DECAY = 0.88;
  const UNITS_KEY = "hypermiler-units";
  const CHANS = ["accel", "brake", "corner", "bump"];

  let useMph = true;
  try {
    const saved = localStorage.getItem(UNITS_KEY);
    if (saved === "kmh") useMph = false;
    if (saved === "mph") useMph = true;
  } catch (_) {}

  const el = {
    speed: document.getElementById("speed"),
    speedUnit: document.getElementById("speed-unit"),
    speedCard: document.getElementById("speed-card"),
    avgSpeed: document.getElementById("avg-speed"),
    val: {
      accel: document.getElementById("val-accel"),
      brake: document.getElementById("val-brake"),
      corner: document.getElementById("val-corner"),
      bump: document.getElementById("val-bump"),
    },
    bar: {
      accel: document.getElementById("bar-accel"),
      brake: document.getElementById("bar-brake"),
      corner: document.getElementById("bar-corner"),
      bump: document.getElementById("bar-bump"),
    },
    ps: {
      accel: document.getElementById("ps-accel"),
      brake: document.getElementById("ps-brake"),
      corner: document.getElementById("ps-corner"),
      bump: document.getElementById("ps-bump"),
    },
    pr: {
      accel: document.getElementById("pr-accel"),
      brake: document.getElementById("pr-brake"),
      corner: document.getElementById("pr-corner"),
      bump: document.getElementById("pr-bump"),
    },
    score: document.getElementById("score"),
    scoreRing: document.getElementById("score-ring"),
    dist: document.getElementById("dist"),
    time: document.getElementById("time"),
    peakDrive: document.getElementById("peak-drive"),
    bumps: document.getElementById("bumps"),
    scored: document.getElementById("scored"),
    hint: document.getElementById("hint"),
    pillMotion: document.getElementById("pill-motion"),
    pillGps: document.getElementById("pill-gps"),
    pillMount: document.getElementById("pill-mount"),
    btnStart: document.getElementById("btn-start"),
    btnPause: document.getElementById("btn-pause"),
    btnReset: document.getElementById("btn-reset"),
  };

  /** Mac/PC only — iPads are wide but touch (coarse); don't treat them as desktop. */
  const DESKTOP_MQ = "(hover: hover) and (pointer: fine) and (min-width: 900px)";

  function isDesktopLayout() {
    return window.matchMedia(DESKTOP_MQ).matches;
  }

  function applyUnitsLabels() {
    el.speedUnit.textContent = useMph ? "mph" : "km/h";
  }
  applyUnitsLabels();

  const DESKTOP_SPEED_MSG = "No sensors here. Open on your phone.";

  function applyDesktopSpeedNudge() {
    const desk = isDesktopLayout();
    el.speedCard.classList.toggle("is-desktop-nudge", desk);
    if (desk) {
      el.speed.textContent = DESKTOP_SPEED_MSG;
      el.speed.classList.add("is-desktop-msg");
      el.speedUnit.classList.add("is-hidden");
    } else {
      el.speed.classList.remove("is-desktop-msg");
      el.speedUnit.classList.remove("is-hidden");
      applyUnitsLabels();
    }
    return desk;
  }

  function emptyPeaks() {
    return { accel: 0, brake: 0, corner: 0, bump: 0 };
  }

  const state = {
    running: false,
    paused: false,
    motionOn: false,
    gpsOn: false,
    speedMps: null,
    lastGps: null,
    lastSpeedT: 0,
    grav: null,
    prevGrav: null,
    forward: null,
    live: { accel: 0, brake: 0, corner: 0, bump: 0 },
    smoothLong: 0,
    smoothLat: 0,
    smoothVert: 0,
    uiLong: 0,
    uiLat: 0,
    uiVert: 0,
    recent: emptyPeaks(),
    recentAt: emptyPeaks(),
    session: emptyPeaks(),
    handheldUntil: 0,
    elapsedMs: 0,
    elapsedTickAt: 0,
    distanceM: 0,
    peakDriveG: 0,
    bumpCount: 0,
    lastBumpAt: 0,
    sampleN: 0,
    sumSq: 0,
    totalMotionN: 0,
    scoredN: 0,
    wakeLock: null,
    geoWatchId: null,
    motionHandler: null,
    raf: 0,
    lastUi: {},
  };

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function v3(x, y, z) {
    return { x, y, z };
  }

  function vLen(v) {
    return Math.hypot(v.x, v.y, v.z);
  }

  function vNorm(v) {
    const L = vLen(v) || 1;
    return v3(v.x / L, v.y / L, v.z / L);
  }

  function vDot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  function vCross(a, b) {
    return v3(
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x
    );
  }

  function vScale(v, s) {
    return v3(v.x * s, v.y * s, v.z * s);
  }

  function vAdd(a, b) {
    return v3(a.x + b.x, a.y + b.y, a.z + b.z);
  }

  function vSub(a, b) {
    return v3(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  function formatG(g) {
    return `${g.toFixed(1)}g`;
  }

  function formatSpeed(mps) {
    if (mps == null || !Number.isFinite(mps) || mps < 0) return "—";
    const v = useMph ? mps * 2.236936 : mps * 3.6;
    return Math.round(v).toString();
  }

  function formatDist(m) {
    if (useMph) {
      const mi = m / 1609.344;
      return `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
    }
    const km = m / 1000;
    return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
  }

  /** Overall trip average: distance / elapsed recording time. */
  function formatAvgSpeed(distanceM, elapsedMs) {
    if (!elapsedMs || elapsedMs < 1000 || distanceM < 5) return "—";
    const mps = distanceM / (elapsedMs / 1000);
    if (!Number.isFinite(mps) || mps < 0) return "—";
    if (useMph) {
      return `${(mps * 2.236936).toFixed(1)} mph`;
    }
    return `${(mps * 3.6).toFixed(1)} km/h`;
  }

  function tripRecording() {
    return state.running && !state.paused;
  }

  function syncElapsed(now) {
    if (tripRecording() && state.elapsedTickAt) {
      state.elapsedMs += now - state.elapsedTickAt;
    }
    state.elapsedTickAt = tripRecording() ? now : 0;
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
    if (g < 0.25) return "tone-green";
    if (g < 0.4) return "tone-amber";
    return "tone-red";
  }

  function barColor(g) {
    if (g < 0.25) return "var(--green)";
    if (g < 0.4) return "var(--amber)";
    return "var(--red)";
  }

  function isMoving() {
    return state.speedMps != null && state.speedMps > MOVE_MPS;
  }

  function isHandheld(now) {
    return now < state.handheldUntil;
  }

  function isTrusted(now) {
    return !isHandheld(now);
  }

  /** Policy A: long/lat RMS only, only while moving + docked. */
  function tripScore() {
    if (state.sampleN < 8) return 100;
    const rms = Math.sqrt(state.sumSq / state.sampleN);
    const rmsPenalty = clamp(rms * SCORE_RMS_WEIGHT, 0, 70);
    return Math.round(clamp(100 - rmsPenalty, 0, 100));
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

  function defaultForward(down) {
    // Prefer phone −Z projected onto horizontal (portrait cabin-facing guess).
    const guess = v3(0, 0, -1);
    let f = vSub(guess, vScale(down, vDot(guess, down)));
    if (vLen(f) < 0.15) {
      const guess2 = v3(0, 1, 0);
      f = vSub(guess2, vScale(down, vDot(guess2, down)));
    }
    return vNorm(f);
  }

  function projectHorizontal(a, down) {
    return vSub(a, vScale(down, vDot(a, down)));
  }

  function learnForward(aLin, down, gpsAccel, now) {
    if (!state.forward) state.forward = defaultForward(down);

    // Learn when GPS reports clear longitudinal accel and sample is trusted.
    if (
      gpsAccel != null &&
      Math.abs(gpsAccel) > 0.55 &&
      isTrusted(now) &&
      isMoving()
    ) {
      let h = projectHorizontal(aLin, down);
      if (gpsAccel < 0) h = vScale(h, -1);
      if (vLen(h) > 0.4) {
        h = vNorm(h);
        state.forward = vNorm(
          vAdd(vScale(state.forward, 1 - FWD_BLEND), vScale(h, FWD_BLEND))
        );
        // Keep forward ⟂ down
        state.forward = vNorm(
          vSub(state.forward, vScale(down, vDot(state.forward, down)))
        );
      }
    } else if (vLen(state.forward) < 0.5) {
      state.forward = defaultForward(down);
    }
  }

  function vehicleGs(aLin, down, forward) {
    const latAxis = vNorm(vCross(down, forward));
    const longAxis = vNorm(vCross(latAxis, down)); // re-orthogonalize forward in plane
    // long: + = accelerate; lat: + = left of vehicle; vert: + = up (bump impulse abs later)
    const longG = vDot(aLin, longAxis) / G;
    const latG = vDot(aLin, latAxis) / G;
    const vertG = -vDot(aLin, down) / G;
    return { longG, latG, vertG };
  }

  function markHandheld(now, reason) {
    state.handheldUntil = Math.max(state.handheldUntil, now + HANDHELD_HOLD_MS);
  }

  function updateGrav(ag) {
    const sample = v3(ag.x, ag.y, ag.z);
    if (!state.grav) {
      state.grav = sample;
      state.prevGrav = sample;
      return vNorm(sample);
    }
    state.prevGrav = state.grav;
    state.grav = v3(
      state.grav.x + GRAV_ALPHA * (sample.x - state.grav.x),
      state.grav.y + GRAV_ALPHA * (sample.y - state.grav.y),
      state.grav.z + GRAV_ALPHA * (sample.z - state.grav.z)
    );
    return vNorm(state.grav);
  }

  function checkHandheldFromGrav(now) {
    if (!state.prevGrav || !state.grav) return;
    const a = vNorm(state.prevGrav);
    const b = vNorm(state.grav);
    const diff = vLen(vSub(a, b));
    if (diff > GRAV_TILT_HANDHELD) markHandheld(now, "tilt");
  }

  function readSensors(event) {
    const a = event.acceleration;
    const ag = event.accelerationIncludingGravity;
    let aLin = null;
    let down = null;

    if (ag && ag.x != null) {
      down = updateGrav(ag);
      checkHandheldFromGrav(performance.now());
    }

    if (a && a.x != null && a.y != null && a.z != null) {
      aLin = v3(a.x, a.y, a.z);
    } else if (ag && ag.x != null && state.grav) {
      aLin = vSub(v3(ag.x, ag.y, ag.z), state.grav);
    }

    if (!down && state.grav) down = vNorm(state.grav);
    if (!down) down = v3(0, -1, 0); // fallback

    return { aLin, down };
  }

  /** Peak holds only while trip is actively recording (started, not paused). */
  function updatePeaks(live, now) {
    for (const ch of CHANS) {
      const v = live[ch];
      if (v >= state.recent[ch]) {
        state.recent[ch] = v;
        state.recentAt[ch] = now;
      } else if (now - (state.recentAt[ch] || 0) > RECENT_HOLD_MS) {
        state.recent[ch] = Math.max(v, state.recent[ch] * RECENT_DECAY);
        if (state.recent[ch] < 0.02) state.recent[ch] = v;
      }
      if (v > state.session[ch]) state.session[ch] = v;
    }
  }

  function freezeLiveMeters() {
    // Bars go quiet; session/recent peak holds stay where they were.
    state.live = { accel: 0, brake: 0, corner: 0, bump: 0 };
    state.uiLong = 0;
    state.uiLat = 0;
    state.uiVert = 0;
    state.lastUi = {};
  }

  function onMotion(event) {
    // Same gate as scoring: meters only move while started and not paused.
    if (!tripRecording()) return;
    const now = performance.now();
    const { aLin, down } = readSensors(event);
    if (!aLin) return;

    // Extreme phone fling
    if (vLen(aLin) / G > 2.2) markHandheld(now, "fling");

    const gpsA =
      state._gpsAccel != null && now - state._gpsAccelAt < 1500
        ? state._gpsAccel
        : null;

    learnForward(aLin, down, gpsA, now);
    const forward = state.forward || defaultForward(down);
    const { longG, latG, vertG } = vehicleGs(aLin, down, forward);

    state.smoothLong += SMOOTH_ALPHA * (longG - state.smoothLong);
    state.smoothLat += SMOOTH_ALPHA * (latG - state.smoothLat);
    state.smoothVert += SMOOTH_ALPHA * (vertG - state.smoothVert);

    const long = state.smoothLong;
    const lat = state.smoothLat;
    const vertAbs = Math.abs(state.smoothVert);

    // Score / peaks use force path (unchanged). Bars get a light extra damp only.
    const forceLive = {
      accel: Math.max(0, long),
      brake: Math.max(0, -long),
      corner: Math.abs(lat),
      bump: vertAbs,
    };

    state.uiLong += DISPLAY_ALPHA * (long - state.uiLong);
    state.uiLat += DISPLAY_ALPHA * (lat - state.uiLat);
    state.uiVert += DISPLAY_ALPHA * (vertAbs - state.uiVert);

    state.live = {
      accel: Math.max(0, state.uiLong),
      brake: Math.max(0, -state.uiLong),
      corner: Math.abs(state.uiLat),
      bump: Math.max(0, state.uiVert),
    };

    state.totalMotionN += 1;

    // Dual peak holds: session + recent from force path, only while recording
    updatePeaks(forceLive, now);

    const trusted = isTrusted(now);

    if (trusted) {
      const driveMag = Math.hypot(long, lat);
      if (driveMag > state.peakDriveG) state.peakDriveG = driveMag;
    }

    // Score samples: policy A — long/lat only, moving + not handheld
    if (trusted && isMoving()) {
      const driveMag = Math.hypot(long, lat);
      state.sampleN += 1;
      state.sumSq += driveMag * driveMag;
      state.scoredN += 1;
    }

    // Bump events: vertical-dominant impulses while trusted
    if (
      trusted &&
      vertAbs >= BUMP_G &&
      vertAbs >= Math.abs(long) * BUMP_DOMINANCE &&
      vertAbs >= Math.abs(lat) * BUMP_DOMINANCE &&
      now - state.lastBumpAt > BUMP_COOLDOWN_MS
    ) {
      state.bumpCount += 1;
      state.lastBumpAt = now;
    }
  }

  function pctHeight(g, maxG) {
    return `${clamp((g / maxG) * 100, 0, 100)}%`;
  }

  function setPeakLine(node, g, maxG) {
    const lbl = node.querySelector(".peak-lbl");
    if (g < 0.02) {
      node.style.opacity = "0";
      if (lbl) lbl.textContent = "";
      return;
    }
    const pct = clamp((g / maxG) * 100, 0, 100);
    const color = barColor(g);
    node.style.bottom = pct + "%";
    node.style.opacity = "1";
    node.style.setProperty("--peak-color", color);
    if (lbl) lbl.textContent = g.toFixed(1);
  }

  function paintChannel(ch, g) {
    const maxG = BAR_MAX_G;
    const key = `${ch}:${Math.round(g * 100)}:${Math.round(state.recent[ch] * 100)}:${Math.round(state.session[ch] * 100)}`;
    if (state.lastUi[ch] === key) return;
    state.lastUi[ch] = key;

    el.val[ch].textContent = formatG(g);
    el.val[ch].className = `g-value ${toneForG(g)}`;
    el.bar[ch].style.height = pctHeight(g, maxG);
    el.bar[ch].style.background = barColor(g);
    setPeakLine(el.ps[ch], state.session[ch], maxG);
    setPeakLine(el.pr[ch], state.recent[ch], maxG);
  }

  function paint() {
    const now = performance.now();
    syncElapsed(now);
    const live = state.live;

    paintChannel("accel", live.accel);
    paintChannel("brake", live.brake);
    paintChannel("corner", live.corner);
    paintChannel("bump", live.bump);

    if (!applyDesktopSpeedNudge()) {
      el.speed.textContent = formatSpeed(state.speedMps);
    }
    el.time.textContent = formatTime(state.elapsedMs);
    el.dist.textContent = formatDist(state.distanceM);
    el.avgSpeed.textContent = formatAvgSpeed(state.distanceM, state.elapsedMs);
    el.peakDrive.textContent = state.peakDriveG.toFixed(1);
    el.bumps.textContent = String(state.bumpCount);

    const scoredPct =
      state.totalMotionN > 0
        ? Math.round((state.scoredN / state.totalMotionN) * 100)
        : 0;
    el.scored.textContent = `${scoredPct}%`;

    // Trip state pill: Recording (green) / Paused (amber) / idle
    if (!state.running) {
      setPill(el.pillMount, "—", null);
    } else if (state.paused) {
      setPill(el.pillMount, "Paused", "warn");
    } else {
      setPill(el.pillMount, "Recording", "on");
    }

    const score = tripScore();
    if (state.lastUi.score !== score) {
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
          setHint("Motion permission denied. Enable motion in Settings.");
          return false;
        }
      } catch (_) {
        setHint("Could not request motion permission. Try again from a tap.");
        return false;
      }
    }
    return true;
  }

  function startMotion() {
    if (state.motionHandler) return;
    state.motionHandler = onMotion;
    window.addEventListener("devicemotion", state.motionHandler, { passive: true });
    state.motionOn = true;
    setPill(el.pillMotion, "Motion on", "on");
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
        const now = performance.now();
        const accOk = accuracy == null || accuracy < 120;

        let newSpeed = null;
        const hasNativeSpeed =
          speed != null && Number.isFinite(speed) && speed >= 0;

        // Prefer GPS chip speed when present (phones / cellular iPads).
        if (hasNativeSpeed) {
          newSpeed = speed;
        } else if (state.lastGps && accOk) {
          // Wi‑Fi iPads often leave coords.speed null — derive from position deltas.
          const dt = (t - state.lastGps.t) / 1000;
          if (dt >= 0.45 && dt <= 5) {
            const d = haversineM(
              state.lastGps.lat,
              state.lastGps.lon,
              latitude,
              longitude
            );
            if (d < 100) {
              const derived = d / dt;
              // Light smooth; snap toward zero when barely moving (GPS jitter).
              if (derived < 0.6) {
                newSpeed =
                  state.speedMps == null
                    ? 0
                    : state.speedMps * 0.55;
              } else if (state.speedMps == null) {
                newSpeed = derived;
              } else {
                newSpeed = state.speedMps * 0.55 + derived * 0.45;
              }
            }
          }
        }

        if (newSpeed != null && Number.isFinite(newSpeed)) {
          if (state.speedMps != null && state.lastSpeedT) {
            const dtS = (now - state.lastSpeedT) / 1000;
            if (dtS > 0.2 && dtS < 3) {
              state._gpsAccel = (newSpeed - state.speedMps) / dtS;
              state._gpsAccelAt = now;
            }
          }
          state.speedMps = Math.max(0, newSpeed);
          state.lastSpeedT = now;
        }

        if (tripRecording() && state.lastGps && accOk) {
          const dt = (t - state.lastGps.t) / 1000;
          if (dt > 0 && dt < 8) {
            const d = haversineM(
              state.lastGps.lat,
              state.lastGps.lon,
              latitude,
              longitude
            );
            // Distance while moving (native or derived speed).
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
          setHint("Location denied. Allow location for speed, distance, and auto-orient.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 }
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
    state._gpsAccel = null;
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
    } catch (_) {}
  }

  async function releaseWakeLock() {
    try {
      await state.wakeLock?.release();
    } catch (_) {}
    state.wakeLock = null;
  }

  function resetTripStats() {
    state.elapsedMs = 0;
    state.elapsedTickAt = tripRecording() ? performance.now() : 0;
    state.distanceM = 0;
    state.peakDriveG = 0;
    state.bumpCount = 0;
    state.lastBumpAt = 0;
    state.sampleN = 0;
    state.sumSq = 0;
    state.totalMotionN = 0;
    state.scoredN = 0;
    state.smoothLong = 0;
    state.smoothLat = 0;
    state.smoothVert = 0;
    state.uiLong = 0;
    state.uiLat = 0;
    state.uiVert = 0;
    state.live = { accel: 0, brake: 0, corner: 0, bump: 0 };
    state.recent = emptyPeaks();
    state.recentAt = emptyPeaks();
    state.session = emptyPeaks();
    state.grav = null;
    state.prevGrav = null;
    state.forward = null;
    state.handheldUntil = 0;
    state.lastUi = {};
  }

  function setPauseUi() {
    if (!state.running) {
      el.btnPause.textContent = "Pause";
      el.btnPause.classList.remove("paused-btn");
      el.btnPause.disabled = true;
      return;
    }
    el.btnPause.disabled = false;
    if (state.paused) {
      el.btnPause.textContent = "Resume";
      el.btnPause.classList.add("paused-btn");
    } else {
      el.btnPause.textContent = "Pause";
      el.btnPause.classList.remove("paused-btn");
    }
  }

  async function startSession() {
    const ok = await requestMotionPermission();
    if (!ok) return;

    startMotion();
    startGps();
    await requestWakeLock();

    state.running = true;
    state.paused = false;
    resetTripStats();
    state.elapsedTickAt = performance.now();

    el.btnStart.textContent = "Stop";
    el.btnStart.classList.add("running");
    el.btnReset.disabled = false;
    setPauseUi();
    setPill(el.pillMount, "Recording", "on");
    setHint("Recording. Peak holds while recording.");
  }

  async function stopSession() {
    syncElapsed(performance.now());
    state.running = false;
    state.paused = false;
    freezeLiveMeters();
    stopMotion();
    stopGps();
    await releaseWakeLock();

    el.btnStart.textContent = "Start";
    el.btnStart.classList.remove("running");
    el.btnReset.disabled = false;
    setPauseUi();
    setPill(el.pillMount, "—", null);

    setHint(
      `Stopped · Smooth <strong>${tripScore()}</strong> · drive peak <strong>${state.peakDriveG.toFixed(1)}g</strong> · bumps <strong>${state.bumpCount}</strong>.`
    );
  }

  function togglePause() {
    if (!state.running) return;
    const now = performance.now();
    if (state.paused) {
      state.paused = false;
      state.elapsedTickAt = now;
      setHint("Resumed. Meters and scoring are live again.");
    } else {
      syncElapsed(now);
      state.paused = true;
      state.elapsedTickAt = 0;
      freezeLiveMeters();
      setHint("Paused. Meters off · peak holds kept · trip stats frozen.");
    }
    setPauseUi();
  }

  async function toggleStart() {
    if (state.running) await stopSession();
    else await startSession();
  }

  function resetAll() {
    const wasPaused = state.paused;
    resetTripStats();
    if (state.running && !wasPaused) {
      state.elapsedTickAt = performance.now();
    }
    if (state.running) {
      setHint(state.paused ? "Trip reset (still paused)." : "Trip reset. Drive on.");
    } else {
      setHint("Tap <strong>Start</strong> — Meter action reflects driving inputs. Reduce g’s to increase MPG and reduce wear.");
    }
  }

  function toggleUnits() {
    useMph = !useMph;
    try {
      localStorage.setItem(UNITS_KEY, useMph ? "mph" : "kmh");
    } catch (_) {}
    applyUnitsLabels();
    state.lastUi = {};
    setHint(
      useMph
        ? "Units: <strong>mph</strong> / miles. Tap speed again for km/h."
        : "Units: <strong>km/h</strong> / km. Tap speed again for mph."
    );
  }

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.running) {
      await requestWakeLock();
      if (tripRecording()) state.elapsedTickAt = performance.now();
    } else if (document.visibilityState === "hidden" && tripRecording()) {
      syncElapsed(performance.now());
      state.elapsedTickAt = 0;
    }
  });

  el.btnStart.addEventListener("click", () => toggleStart());
  el.btnPause.addEventListener("click", () => togglePause());
  el.btnReset.addEventListener("click", () => resetAll());
  el.speedCard.addEventListener("click", () => {
    if (isDesktopLayout()) return;
    toggleUnits();
  });
  el.speedCard.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (isDesktopLayout()) return;
      toggleUnits();
    }
  });
  window.matchMedia(DESKTOP_MQ).addEventListener("change", () => {
    applyDesktopSpeedNudge();
    state.lastUi = {};
  });
  applyDesktopSpeedNudge();

  const fit = window.FitToScreen.create({
    stage: "fit-stage",
    app: "app",
    // Include iPad widths so tablets use the phone fit path (scale-to-fill), not Mac "wide".
    phoneMaxWidth: 1180,
    // Fixed design width so scale can grow equally into spare height (full-bleed width caps scale at 1).
    phoneAppWidth: 360,
    wideAppWidth: 400,
    // Phone/iPad may scale up; real desktop caps at 1 so menu show/hide does not reflow header.
    capScaleAtOne: false,
    getCapScaleAtOne: function () {
      return isDesktopLayout();
    },
    // Desktop only: reserve vertical space so scale-down keeps buttons above the window edge.
    getTopBuffer: function () {
      return isDesktopLayout() ? 88 : 0;
    },
  });
  fit.bindViewportListeners();
  fit.bootLayout();

  paint();
})();
