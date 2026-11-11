import { initFacets } from "./facets-utils.js";

export function initAdminFacets(root) {
  initFacets(root, { prefix: "admin", defaultPanelId: "users" });
}

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-admin-facets]");
  if (root) initAdminFacets(root);
}
