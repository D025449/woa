import { CognitoJwtVerifier } from "aws-jwt-verify";
import UserDBService from "../services/userDBService.js"
import { normalizeSupportedLocale } from "../i18n/index.js";
import { clearAuthCookies, refreshAccessTokens, setAuthCookies } from "../services/authTokenService.js";

let accessVerifier;
let idVerifier;

function getAccessVerifier() {
  if (!accessVerifier) {
    accessVerifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: "access",
      clientId: process.env.COGNITO_CLIENT_ID,
    });
  }
  return accessVerifier;
}

function getIdVerifier() {
  if (!idVerifier) {
    idVerifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: "id",
      clientId: process.env.COGNITO_CLIENT_ID,
    });
  }
  return idVerifier;
}

function clearAuthState(req, res) {
  clearAuthCookies(res);
  if (req.session?.user_id || req.session?.user) {
    delete req.session.user_id;
    delete req.session.user;
  }
}

export default async function authGlobal(req, res, next) {

  try {
    let token = req.cookies.accessToken;
    let idToken = req.cookies.idToken;
    const refreshToken = req.cookies.refreshToken;

    if (!token && req.session?.user_id && req.session?.user?.sub) {
      if (req.session?.user?.account_status === "deleted") {
        clearAuthState(req, res);
        req.user = null;
        res.locals.user = null;
        return next();
      }

      req.user = {
        id: req.session.user_id,
        sub: req.session.user.sub,
        email: req.session?.user?.email,
        display_name: req.session?.user?.display_name,
        language: req.session?.user?.language || "en",
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

    const user = {
      sub: accessPayload.sub,
      email: idPayload?.email || accessPayload.email,
      email_verified: idPayload?.email_verified,
      username: idPayload?.["cognito:username"] || accessPayload.username,
      name: idPayload?.name || idPayload?.given_name
    };

    const dbuser = await UserDBService.ensureUserExists(user);
    const language = await UserDBService.getUserLanguage(dbuser.id);
    const normalizedLanguage = normalizeSupportedLocale(language, "en");

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
      account_status: dbuser.account_status || "active",
      deletion_requested_at: dbuser.deletion_requested_at || null,
      deletion_scheduled_for: dbuser.deletion_scheduled_for || null,
      deleted_at: dbuser.deleted_at || null
    };

    if (dbuser.account_status === "deleted") {
      clearAuthState(req, res);
      req.user = null;
      res.locals.user = null;
      return next();
    }

    res.locals.user = req.user;

    next();

  } catch (err) {

    console.warn("JWT verify failed:", err.message);

    clearAuthState(req, res);

    next();

  }
}

/*export default async function authGlobal(req, res, next) {

  try {

    const token = req.cookies.accessToken;

    if (!token) {
      return next();
    }
    verifier = getVerifier();
    const payload = await verifier.verify(token);

    const user = {
      sub: payload.sub,
      email: payload.email,
      username: payload.username
    };

    req.user = user;
    res.locals.user = user;

    // 👇 User automatisch synchronisieren
    const dbuser = await UserDBService.ensureUserExists(user);
    console.log(dbuser);

    next();

  } catch (err) {

    console.warn("JWT verify failed:", err.message);

    next();

  }

}*/
