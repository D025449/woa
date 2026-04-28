import GroupsController from "./groups-controller.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";

document.addEventListener("DOMContentLoaded", () => {
  new GroupsController({
    t: createTranslator("groups"),
    locale: getCurrentLocale()
  });
});
