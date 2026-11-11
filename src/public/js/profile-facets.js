import { initFacets } from "./facets-utils.js";

const root = document.querySelector("[data-profile-facets]");

if (root) {
  const params = new URLSearchParams(window.location.search);
  const initialFacet = params.has("payment") ? "membership" : params.has("wahoo") ? "connections" : null;
  if (initialFacet) {
    const url = new URL(window.location.href);
    if (!url.hash || initialFacet === "membership") url.hash = initialFacet;
    window.history.replaceState(window.history.state, "", url);
  }

  const { activate } = initFacets(root, { prefix: "profile" });

  const panels = Array.from(root.querySelectorAll("[data-profile-panel]"));
  document.addEventListener("profile-reveal-field", event => {
    const target = document.getElementById(event.detail);
    const panel = panels.find(candidate => candidate.contains(target));
    if (!panel) return;
    const hash = `#${panel.id}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    activate();
    target.focus();
  });
}
