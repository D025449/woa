import fs from "fs";
import path from "path";
import url from "url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const I18N_DIR_PATH = path.join(__dirname, "..", "public", "i18n");

let cachedSupportedLocales = null;
let cachedMessageBundles = null;

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

export function getSupportedLocales() {
  if (cachedSupportedLocales) {
    return cachedSupportedLocales;
  }

  cachedSupportedLocales = fs.readdirSync(I18N_DIR_PATH)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.basename(name, ".json").toLowerCase())
    .filter((locale) => /^[a-z]{2}$/.test(locale));

  if (!cachedSupportedLocales.includes("en")) {
    cachedSupportedLocales.push("en");
  }

  return cachedSupportedLocales;
}

export function normalizeSupportedLocale(value, fallback = "en") {
  const candidate = String(value || "").trim().toLowerCase();
  const supportedLocales = getSupportedLocales();
  return supportedLocales.includes(candidate) ? candidate : fallback;
}

function loadMessageBundles() {
  if (cachedMessageBundles) {
    return cachedMessageBundles;
  }

  cachedMessageBundles = Object.fromEntries(
    getSupportedLocales().map((locale) => {
      const filePath = path.join(I18N_DIR_PATH, `${locale}.json`);
      return [locale, JSON.parse(fs.readFileSync(filePath, "utf8"))];
    })
  );
  return cachedMessageBundles;
}

export function createI18nMiddleware() {
  const supportedLocales = getSupportedLocales();
  const bundles = loadMessageBundles();

  function normalizeLocale(value) {
    const normalized = normalizeSupportedLocale(value, "__invalid__");
    return normalized === "__invalid__" ? null : normalized;
  }

  function pickFromAcceptLanguage(headerValue) {
    const header = String(headerValue || "").toLowerCase();
    if (header.includes("de")) {
      return "de";
    }
    if (header.includes("en")) {
      return "en";
    }
    for (const locale of supportedLocales) {
      if (header.includes(locale)) {
        return locale;
      }
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
      messages,
      supportedLocales
    };
    res.locals.supportedLocales = supportedLocales;

    next();
  };
}
