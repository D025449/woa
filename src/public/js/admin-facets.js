export function initAdminFacets(root) {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const panels = Array.from(root.querySelectorAll("[data-admin-panel]"));
  const links = Array.from(root.querySelectorAll("[data-admin-link]"));
  const select = root.querySelector("[data-admin-select]");

  function activate() {
    let target;
    try { target = document.getElementById(decodeURIComponent(view.location.hash.slice(1))); }
    catch { target = null; }
    const active = panels.find(panel => panel === target || panel.contains(target))
      || panels.find(panel => panel.id === "users");
    panels.forEach(panel => { panel.hidden = panel !== active; });
    links.forEach(link => {
      if (link.hash === `#${active.id}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    select.value = active.id;
    if (target && target !== active) target.scrollIntoView({ block: "start" });
  }

  links.forEach(link => link.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (view.location.hash !== link.hash) view.history.pushState(null, "", link.hash);
    activate();
  }));
  select.addEventListener("change", () => {
    view.history.pushState(null, "", `#${select.value}`);
    activate();
  });
  view.addEventListener("hashchange", activate);
  view.addEventListener("popstate", activate);
  activate();
  root.dataset.facetsReady = "true";
}

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-admin-facets]");
  if (root) initAdminFacets(root);
}