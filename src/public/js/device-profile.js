(function initDeviceProfile(globalScope) {
  const MOBILE_LAYOUT_MAX_WIDTH = 900;
  const TABLET_LAYOUT_MAX_WIDTH = 1200;

  function readMediaQuery(query) {
    if (typeof globalScope.matchMedia !== "function") {
      return false;
    }
    return globalScope.matchMedia(query).matches;
  }

  function buildProfile() {
    const viewportWidth = globalScope.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = globalScope.innerHeight || document.documentElement.clientHeight || 0;
    const isNarrowViewport = viewportWidth > 0 && viewportWidth <= MOBILE_LAYOUT_MAX_WIDTH;
    const isTabletViewport = viewportWidth > MOBILE_LAYOUT_MAX_WIDTH && viewportWidth <= TABLET_LAYOUT_MAX_WIDTH;
    const isTouchLike = readMediaQuery("(pointer: coarse)");
    const hasHover = readMediaQuery("(hover: hover)");
    const isMobileLayout = isNarrowViewport;
    const isCompactLayout = isMobileLayout || isTabletViewport;

    return {
      viewportWidth,
      viewportHeight,
      isNarrowViewport,
      isTabletViewport,
      isTouchLike,
      hasHover,
      isMobileLayout,
      isCompactLayout
    };
  }

  function syncDocumentState(profile) {
    const root = document.documentElement;
    const body = document.body;

    if (!root || !body) {
      return;
    }

    root.dataset.mobileLayout = profile.isMobileLayout ? "1" : "0";
    root.dataset.compactLayout = profile.isCompactLayout ? "1" : "0";
    root.dataset.touchLike = profile.isTouchLike ? "1" : "0";
    root.dataset.hasHover = profile.hasHover ? "1" : "0";

    body.classList.toggle("device-mobile-layout", profile.isMobileLayout);
    body.classList.toggle("device-compact-layout", profile.isCompactLayout);
    body.classList.toggle("device-touch-like", profile.isTouchLike);
    body.classList.toggle("device-no-hover", !profile.hasHover);
  }

  function emitProfile(profile) {
    globalScope.__DEVICE_PROFILE__ = profile;
    syncDocumentState(profile);
    globalScope.dispatchEvent(new CustomEvent("deviceprofilechange", {
      detail: profile
    }));
  }

  let pendingFrame = null;

  function refreshProfile() {
    if (pendingFrame != null) {
      globalScope.cancelAnimationFrame(pendingFrame);
    }

    pendingFrame = globalScope.requestAnimationFrame(() => {
      pendingFrame = null;
      emitProfile(buildProfile());
    });
  }

  globalScope.getDeviceProfile = function getDeviceProfile() {
    return globalScope.__DEVICE_PROFILE__ || buildProfile();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refreshProfile, { once: true });
  } else {
    refreshProfile();
  }

  globalScope.addEventListener("resize", refreshProfile, { passive: true });

  ["(pointer: coarse)", "(hover: hover)"].forEach((query) => {
    if (typeof globalScope.matchMedia !== "function") {
      return;
    }
    const mediaQuery = globalScope.matchMedia(query);
    const handler = () => refreshProfile();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handler);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handler);
    }
  });
})(window);
