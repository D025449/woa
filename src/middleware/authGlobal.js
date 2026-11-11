import UserDBService from "../services/userDBService.js"
import { normalizeSupportedLocale } from "../i18n/index.js";
import { clearAuthSession, decodeJwtPayload, getAccessVerifier,
  getIdVerifier, refreshAccessTokens, setAuthCookies } from "../services/authTokenService.js";

export default async function authGlobal(req, res, next) {

  try {
    let token = req.cookies.accessToken;
    let idToken = req.cookies.idToken;
    const refreshToken = req.cookies.refreshToken;

    if (!token && req.session?.user_id && req.session?.user?.sub) {
      if (req.session?.user?.account_status === "deleted") {
        clearAuthSession(req, res);
        req.user = null;
        res.locals.user = null;
        return next();
      }

      if (typeof req.session.user.is_admin !== "boolean") {
        const appSettings = await UserDBService.getUserAppSettings(req.session.user_id);
        req.session.user.is_admin = appSettings.isAdmin;
      }

      req.user = {
        id: req.session.user_id,
        sub: req.session.user.sub,
        email: req.session?.user?.email,
        display_name: req.session?.user?.display_name,
        language: req.session?.user?.language || "en",
        show_sudoku: Boolean(req.session?.user?.show_sudoku),
        is_admin: Boolean(req.session?.user?.is_admin),
        account_status: req.session?.user?.account_status || "active",
        deletion_requested_at: req.session?.user?.deletion_requested_at || null,
        deletion_scheduled_for: req.session?.user?.deletion_scheduled_for || null,
        deleted_at: req.session?.user?.deleted_at || null
      };
      res.locals.user = req.user;
      return next();
    }

    if (!token) {
      return next();
    }
    let accessPayload;
    let idPayload = idToken
      ? await getIdVerifier().verify(idToken).catch(() => null)
      : null;
    const decodedIdPayload = decodeJwtPayload(idToken);

    try {
      accessPayload = await getAccessVerifier().verify(token);
    } catch (verifyError) {
      if (!refreshToken) {
        throw verifyError;
      }

      const refreshedTokens = await refreshAccessTokens(
        refreshToken,
        req.session?.user?.email || req.session?.user?.sub || ""
      );

      token = refreshedTokens.accessToken;
      idToken = refreshedTokens.idToken || idToken;

      if (!token) {
        throw verifyError;
      }

      setAuthCookies(res, {
        accessToken: token,
        idToken
      }, refreshToken);

      accessPayload = await getAccessVerifier().verify(token);
      idPayload = refreshedTokens.idPayload
        || (idToken ? await getIdVerifier().verify(idToken).catch(() => null) : null);
    }

    const effectiveIdPayload = idPayload || decodedIdPayload || null;

    const user = {
      sub: accessPayload.sub,
      email: effectiveIdPayload?.email || accessPayload.email,
      email_verified: effectiveIdPayload?.email_verified,
      username: effectiveIdPayload?.["cognito:username"] || accessPayload.username || accessPayload.client_id,
      name: effectiveIdPayload?.name || effectiveIdPayload?.given_name || effectiveIdPayload?.email
    };

    const dbuser = await UserDBService.ensureUserExists(user);
    const appSettings = await UserDBService.getUserAppSettings(dbuser.id);
    const normalizedLanguage = normalizeSupportedLocale(appSettings.language, "en");

    // Keep locale cookie aligned with the authenticated user's preference.
    res.cookie("lang", normalizedLanguage, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    // Session immer auf den gerade verifizierten Token synchronisieren.
    req.session.user_id = dbuser.id;
    req.session.user = {
      id: dbuser.id,
      sub: user.sub,
      email: dbuser.email,
      display_name: dbuser.display_name,
      language: normalizedLanguage,
      show_sudoku: appSettings.showSudoku,
      is_admin: appSettings.isAdmin,
      account_status: dbuser.account_status || "active",
      deletion_requested_at: dbuser.deletion_requested_at || null,
      deletion_scheduled_for: dbuser.deletion_scheduled_for || null,
      deleted_at: dbuser.deleted_at || null
    };

    // 🔥 5. Request setzen
    req.user = {
      id: dbuser.id,
      sub: user.sub,
      email: dbuser.email,
      username: user.username,
      display_name: dbuser.display_name,
      language: normalizedLanguage,
      show_sudoku: appSettings.showSudoku,
      is_admin: appSettings.isAdmin,
      account_status: dbuser.account_status || "active",
      deletion_requested_at: dbuser.deletion_requested_at || null,
      deletion_scheduled_for: dbuser.deletion_scheduled_for || null,
      deleted_at: dbuser.deleted_at || null
    };

    if (dbuser.account_status === "deleted") {
      clearAuthSession(req, res);
      req.user = null;
      res.locals.user = null;
      return next();
    }

    res.locals.user = req.user;

    next();

  } catch (err) {
    console.warn("JWT verify failed:", err?.message || err?.name || err);

    if (req.session?.user_id && req.session?.user?.sub) {
      req.user = {
        id: req.session.user_id,
        sub: req.session.user.sub,
        email: req.session?.user?.email,
        display_name: req.session?.user?.display_name,
        language: req.session?.user?.language || "en",
        show_sudoku: Boolean(req.session?.user?.show_sudoku),
        is_admin: Boolean(req.session?.user?.is_admin),
        account_status: req.session?.user?.account_status || "active",
        deletion_requested_at: req.session?.user?.deletion_requested_at || null,
        deletion_scheduled_for: req.session?.user?.deletion_scheduled_for || null,
        deleted_at: req.session?.user?.deleted_at || null
      };
      res.locals.user = req.user;
      return next();
    }

    clearAuthSession(req, res);

    next();

  }
}
