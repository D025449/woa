import { CognitoJwtVerifier } from "aws-jwt-verify";
import UserDBService from "../services/userDBService.js";
import { clearAuthCookies as clearAuthCookiesOnResponse, refreshAccessTokens, setAuthCookies } from "../services/authTokenService.js";

let accessVerifier;
let idVerifier;

function decodeJwtPayload(token) {
  if (!token) {
    return null;
  }

  try {
    const [, payload] = token.split(".");
    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "="
    );

    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function clearAuthCookies(req, res) {
  clearAuthCookiesOnResponse(res);

  if (req.session?.user_id || req.session?.user) {
    delete req.session.user_id;
    delete req.session.user;
  }
}

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


export default async function authMiddleware(req, res, next) {
  try {
    /*const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }*/
    if (req?.user?.id) {
      if (req.user.account_status === "deleted") {
        clearAuthCookies(req, res);
        return res.status(403).json({ error: "Account has been deleted" });
      }
      return next();

    }

    let token = req.cookies.accessToken;
    let idToken = req.cookies.idToken;
    const refreshToken = req.cookies.refreshToken;

    if (!token) {
      res.locals.user = null;
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


    req.user = {
      id: dbuser.id,
      sub: accessPayload.sub,
      email: dbuser.email,
      username: user.username,
      display_name: dbuser.display_name,
      account_status: dbuser.account_status || "active",
      deletion_requested_at: dbuser.deletion_requested_at || null,
      deletion_scheduled_for: dbuser.deletion_scheduled_for || null,
      deleted_at: dbuser.deleted_at || null
    };

    if (dbuser.account_status === "deleted") {
      clearAuthCookies(req, res);
      return res.status(403).json({ error: "Account has been deleted" });
    }

    next();

  } catch (err) {
    console.error("JWT verification failed:", err);
    return res.status(401).json({ error: "Invalid token" });
  }
};
