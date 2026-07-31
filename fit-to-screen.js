/**
 * FitToScreen — shared viewport-fit kit for scaled-canvas web apps.
 * Sizes the stage to the visible viewport, waits for stability at open,
 * and avoids the scale(1) remeasure flash that causes shrink-on-open on iOS.
 */
(function (root) {
  "use strict";

  function resolveEl(elOrId) {
    if (!elOrId) return null;
    if (typeof elOrId === "string") return document.getElementById(elOrId);
    return elOrId;
  }

  function create(options) {
    const {
      stage: stageOpt = "fit-stage",
      app: appOpt = "app",
      phoneMaxWidth = 767,
      wideAppWidth = 560,
      /** If set, phone layout width is min(availW, phoneAppWidth) so scale can grow into leftover height. */
      phoneAppWidth = null,
      phoneTopBuffer = 0,
      scaleEpsilon = 0.008,
      settleMaxMs = 600,
      settleStableFrames = 4,
      resizeGraceMs = 350,
      capScaleAtOne = true,
      getCapScaleAtOne = null,
      shouldFit = () => true,
      getTopBuffer,
      onFit = () => {},
    } = options || {};

    const topBufferFor =
      getTopBuffer || ((layout) => (layout === "phone" ? phoneTopBuffer : 0));

    let stage = null;
    let app = null;
    let fitFrame = 0;
    let fitNaturalH = 0;
    let fitNaturalW = 0;
    let fitAvailH = 0;
    let fitAvailW = 0;
    let fitLayout = "";
    let appliedScale = 0;
    let layoutReady = false;
    let layoutShownAt = 0;
    let listenersBound = false;

    function ensureElements() {
      if (!stage) stage = resolveEl(stageOpt);
      if (!app) app = resolveEl(appOpt);
      return stage && app;
    }

    function isPhoneLayout(availW) {
      return availW <= phoneMaxWidth;
    }

    function appLayoutWidth(availW) {
      if (!isPhoneLayout(availW)) return wideAppWidth;
      if (phoneAppWidth != null && phoneAppWidth > 0) {
        return Math.min(availW, phoneAppWidth);
      }
      return availW;
    }

    function isStandaloneDisplay() {
      try {
        return (
          root.matchMedia("(display-mode: standalone)").matches ||
          root.navigator.standalone === true
        );
      } catch (_) {
        return false;
      }
    }

    function syncFitStageViewport() {
      if (!ensureElements()) return;
      const vv = root.visualViewport;
      // Safari tab only: pin to visible viewport so buttons clear the toolbar.
      // PWA: full edge stretch (inset:0) — no short box, no dead space under UI.
      if (!vv || !isPhoneLayout(root.innerWidth) || isStandaloneDisplay()) {
        stage.style.top = "";
        stage.style.left = "";
        stage.style.right = "";
        stage.style.bottom = "";
        stage.style.width = "";
        stage.style.height = "";
        return;
      }
      stage.style.top = `${Math.max(0, Math.round(vv.offsetTop) || 0)}px`;
      stage.style.left = `${Math.max(0, Math.round(vv.offsetLeft) || 0)}px`;
      stage.style.right = "auto";
      stage.style.bottom = "auto";
      stage.style.width = `${Math.round(vv.width)}px`;
      stage.style.height = `${Math.round(vv.height)}px`;
    }

    function viewportSizeMatchesFit() {
      if (!ensureElements() || !layoutReady) return false;
      syncFitStageViewport();
      return stage.clientHeight === fitAvailH && stage.clientWidth === fitAvailW;
    }

    function fitToScreen(remasure = false) {
      if (!ensureElements() || !shouldFit()) return;

      syncFitStageViewport();

      const availH = stage.clientHeight;
      const availW = stage.clientWidth;
      const viewportChanged = availH !== fitAvailH || availW !== fitAvailW;
      const layout = isPhoneLayout(availW) ? "phone" : "wide";
      const layoutChanged = layout !== fitLayout;

      app.style.width = `${appLayoutWidth(availW)}px`;
      app.dataset.layout = layout;

      if (remasure || viewportChanged || layoutChanged || !fitNaturalH) {
        const alreadyFitted = app.classList.contains("is-fitted");
        if (!alreadyFitted) app.style.transform = "scale(1)";
        fitNaturalH = app.offsetHeight;
        fitNaturalW = app.offsetWidth;
        if (!alreadyFitted) app.style.transform = "";
        fitAvailH = availH;
        fitAvailW = availW;
        fitLayout = layout;
      }

      if (!fitNaturalH || !fitNaturalW) return;

      const buffer = topBufferFor(layout);
      const standalone = isStandaloneDisplay();
      const cs = root.getComputedStyle(stage);
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      // Safari needs a little slack under buttons; PWA should fill (no short meters / gap).
      const SAFETY = standalone ? 2 : 10;
      const contentH = Math.max(1, availH - padT - padB - buffer - SAFETY);
      const contentW = Math.max(1, availW - padL - padR - (standalone ? 0 : 2));
      let scale = Math.min(contentH / fitNaturalH, contentW / fitNaturalW);
      const capAtOne = getCapScaleAtOne
        ? getCapScaleAtOne(layout, availW, availH)
        : capScaleAtOne;
      if (capAtOne) scale = Math.min(scale, 1);
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;

      // PWA: center so spare space is even. Safari: top so toolbar doesn't eat buttons.
      app.style.transformOrigin = standalone ? "center center" : "top center";

      if (
        layoutReady &&
        app.classList.contains("is-fitted") &&
        Math.abs(scale - appliedScale) < scaleEpsilon
      ) {
        return;
      }

      app.style.transform = `scale(${scale})`;
      appliedScale = scale;
      if (!app.classList.contains("is-fitted")) {
        layoutShownAt = performance.now();
      }
      app.classList.add("is-fitted");
      layoutReady = true;
      onFit({ scale, layout, availH, availW });
    }

    function scheduleFitToScreen(remasure = false) {
      if (!remasure && viewportSizeMatchesFit()) return;
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => fitToScreen(remasure));
    }

    function settleViewport() {
      if (!ensureElements()) return Promise.resolve();

      let stable = 0;
      let lastW = -1;
      let lastH = -1;
      const start = performance.now();

      return new Promise((resolve) => {
        function tick() {
          syncFitStageViewport();
          const w = stage.clientWidth;
          const h = stage.clientHeight;

          if (w > 0 && h > 0 && w === lastW && h === lastH) {
            stable += 1;
            if (stable >= settleStableFrames) {
              resolve();
              return;
            }
          } else {
            stable = 0;
            lastW = w;
            lastH = h;
          }

          if (performance.now() - start >= settleMaxMs) {
            resolve();
            return;
          }

          requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
      });
    }

    async function bootLayout() {
      if (document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch (_) {}
      }
      await settleViewport();
      fitToScreen(true);
    }

    function resetNaturalSize() {
      fitNaturalH = 0;
      fitNaturalW = 0;
    }

    function onViewportResize() {
      if (!layoutReady) return;
      if (performance.now() - layoutShownAt < resizeGraceMs) return;
      scheduleFitToScreen(true);
    }

    function onOrientationChange() {
      scheduleFitToScreen(true);
    }

    function bindViewportListeners() {
      if (listenersBound) return;
      listenersBound = true;
      root.addEventListener("resize", onViewportResize);
      root.addEventListener("orientationchange", onOrientationChange);
      root.visualViewport?.addEventListener("resize", onViewportResize);
    }

    return {
      syncFitStageViewport,
      fitToScreen,
      scheduleFitToScreen,
      settleViewport,
      bootLayout,
      resetNaturalSize,
      bindViewportListeners,
      isLayoutReady: () => layoutReady,
      getAppliedScale: () => appliedScale,
    };
  }

  root.FitToScreen = { create };
})(typeof window !== "undefined" ? window : globalThis);