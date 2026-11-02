const root = document.querySelector("[data-profile-facets]");

if (root) {
  const panels = Array.from(root.querySelectorAll("[data-profile-panel]"));
  const links = Array.from(root.querySelectorAll("[data-profile-link]"));
  const select = root.querySelector("[data-profile-select]");

  function activate() {
    let target;
    try {
      target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    } catch {
      target = null;
    }
    const active = panels.find(panel => panel === target || panel.contains(target)) || panels[0];
    panels.forEach(panel => { panel.hidden = panel !== active; });
    links.forEach(link => {
      if (link.hash === `#${active.id}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    select.value = active.id;
    if (target && target !== active) target.scrollIntoView({ block: "start" });
  }

  const params = new URLSearchParams(window.location.search);
  const initialFacet = params.has("payment") ? "membership" : params.has("wahoo") ? "connections" : null;
  if (initialFacet) {
    const url = new URL(window.location.href);
    if (!url.hash || initialFacet === "membership") url.hash = initialFacet;
    window.history.replaceState(window.history.state, "", url);
  }

  links.forEach(link => link.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (window.location.hash !== link.hash) window.history.pushState(null, "", link.hash);
    activate();
  }));
  select.addEventListener("change", () => {
    window.history.pushState(null, "", `#${select.value}`);
    activate();
  });
  document.addEventListener("profile-reveal-field", event => {
    const target = document.getElementById(event.detail);
    const panel = panels.find(candidate => candidate.contains(target));
    if (!panel) return;
    const hash = `#${panel.id}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    activate();
    target.focus();
  });
  window.addEventListener("hashchange", activate);
  window.addEventListener("popstate", activate);
  activate();
  root.dataset.facetsReady = "true";
}