import fs from "fs";
import path from "path";
import url from "url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EN_MESSAGES_PATH = path.join(__dirname, "..", "public", "i18n", "en.json");
const DE_MESSAGES_PATH = path.join(__dirname, "..", "public", "i18n", "de.json");

let cachedEnMessages = null;
let cachedDeMessages = null;

function loadEnMessages() {
  if (!cachedEnMessages) {
    const fileContent = fs.readFileSync(EN_MESSAGES_PATH, "utf8");
    cachedEnMessages = JSON.parse(fileContent);
  }

  return cachedEnMessages;
}

function loadDeMessages() {
  if (!cachedDeMessages) {
    const fileContent = fs.readFileSync(DE_MESSAGES_PATH, "utf8");
    cachedDeMessages = JSON.parse(fileContent);
  }

  return cachedDeMessages;
}

function getByPath(source, key) {
  if (!source || !key) {
    return undefined;
  }

  return String(key)
    .split(".")
    .reduce((acc, part) => (acc && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined), source);
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(params, token)) {
      return String(params[token]);
    }

    return match;
  });
}

export function translate(messages, key, params = {}) {
  const value = getByPath(messages, key);
  if (typeof value !== "string") {
    return key;
  }

  return interpolate(value, params);
}

export function createI18nMiddleware() {
  const enMessages = loadEnMessages();
  const deMessages = loadDeMessages();
  const bundles = {
    en: enMessages,
    de: deMessages
  };

  function normalizeLocale(value) {
    const candidate = String(value || "").trim().toLowerCase();
    return candidate === "de" ? "de" : candidate === "en" ? "en" : null;
  }

  function pickFromAcceptLanguage(headerValue) {
    const header = String(headerValue || "").toLowerCase();
    if (header.includes("de")) {
      return "de";
    }
    if (header.includes("en")) {
      return "en";
    }
    return null;
  }

  return (req, res, next) => {
    const queryLocale = normalizeLocale(req.query?.lang);
    if (queryLocale) {
      res.cookie("lang", queryLocale, {
        httpOnly: false,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 365
      });
      if (req.session?.user) {
        req.session.user.language = queryLocale;
      }
    }

    const cookieLocale = normalizeLocale(req.cookies?.lang);
    const sessionLocale = normalizeLocale(req.session?.user?.language);
    const acceptLocale = pickFromAcceptLanguage(req.headers["accept-language"]);

    const locale = queryLocale || sessionLocale || cookieLocale || acceptLocale || "en";
    const messages = bundles[locale] || bundles.en;

    res.locals.locale = locale;
    res.locals.messages = messages;
    res.locals.t = (key, params = {}) => translate(messages, key, params);
    res.locals.i18n = {
      locale,
      messages
    };

    next();
  };
}
