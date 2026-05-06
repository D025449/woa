import ActivityFeedController from "./activity-feed-controller.js";
import GroupInvitesView from "./group-invites-view.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";

document.addEventListener("DOMContentLoaded", async () => {
  const shellFrame = document.getElementById("home-shell-frame");
  const shell = document.getElementById("home-shell");
  let layoutRaf = null;
  let layoutObserver = null;

  function measureClientLayout() {
    if (!shellFrame || !shell) {
      return;
    }

    const topbar = document.querySelector(".app-topbar, .home-topbar");
    const container = document.querySelector(".home-client-container");
    const bodyStyles = window.getComputedStyle(document.body);
    const containerStyles = container ? window.getComputedStyle(container) : null;
    const topbarHeight = topbar?.offsetHeight || 0;
    const fixedTopbarOffset = topbar?.classList.contains("fixed-top") ? topbarHeight + 12 : 0;
    const bodyOffsetTop = parseFloat(bodyStyles.paddingTop || "0") || 0;
    const reservedTopOffset = fixedTopbarOffset || bodyOffsetTop || topbarHeight;
    const paddingTop = containerStyles ? parseFloat(containerStyles.paddingTop || "0") : 0;
    const paddingBottom = containerStyles ? parseFloat(containerStyles.paddingBottom || "0") : 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const availableHeight = Math.max(520, viewportHeight - reservedTopOffset - paddingTop - paddingBottom);

    if (fixedTopbarOffset) {
      document.documentElement.style.setProperty("--app-topbar-offset", `${fixedTopbarOffset}px`);
      document.body.classList.add("has-fixed-app-topbar");
    }

    shellFrame.style.setProperty("--home-client-height", `${availableHeight}px`);
    shell.classList.add("home-shell--client");
  }

  function scheduleClientLayoutMeasure() {
    if (layoutRaf) {
      window.cancelAnimationFrame(layoutRaf);
    }

    layoutRaf = window.requestAnimationFrame(() => {
      layoutRaf = null;
      measureClientLayout();
    });
  }

  scheduleClientLayoutMeasure();

  const feedList = document.querySelector("#home-feed-list");
  const invitesContainer = document.querySelector("#home-group-invites-list");

  if (!feedList || !invitesContainer) {
    return;
  }

  const t = createTranslator("groups");
  const locale = getCurrentLocale();

  const controller = new ActivityFeedController({
    namespace: "homeActivityFeed",
    idPrefix: "home",
    listSelector: "#home-feed-list",
    t,
    locale
  });

  const invitesView = new GroupInvitesView("#home-group-invites-list", {
    onAcceptInvite: async (invite) => {
      await respondToInvite(invite, "accept");
    },
    onDeclineInvite: async (invite) => {
      await respondToInvite(invite, "decline");
    }
  }, t);

  async function fetchInvites() {
    const response = await fetch("/collaboration/invites", {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return [];
    }

    if (!response.ok) {
      throw new Error(t("messages.failedLoadInvites", { status: response.status }));
    }

    const result = await response.json();
    return result.data || [];
  }

  async function respondToInvite(invite, action) {
    if (!invite?.id) {
      return;
    }

    const response = await fetch(`/collaboration/invites/${encodeURIComponent(invite.id)}/${action}`, {
      method: "POST",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || t("messages.failedInviteAction", { action, status: response.status }));
    }

    const invites = await fetchInvites();
    invitesView.render(invites);
  }

  controller.registerEvents();
  window.addEventListener("resize", scheduleClientLayoutMeasure);

  if (typeof ResizeObserver === "function") {
    const topbar = document.querySelector(".app-topbar");
    const hero = document.querySelector(".home-hero");
    const tiles = document.querySelector(".home-tile-grid");
    layoutObserver = new ResizeObserver(() => {
      scheduleClientLayoutMeasure();
    });
    [topbar, hero, tiles, shellFrame].filter(Boolean).forEach((element) => layoutObserver.observe(element));
  }

  try {
    const invites = await fetchInvites();
    invitesView.render(invites);
  } catch (err) {
    console.error(err);
    invitesView.render([]);
  }

  await controller.boot();
});
