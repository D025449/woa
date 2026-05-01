import { CognitoJwtVerifier } from "aws-jwt-verify";
import UserDBService from "../services/userDBService.js";

let accessVerifier;
let idVerifier;

function clearAuthCookies(req, res) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
  res.clearCookie("idToken");

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

    const token = req.cookies.accessToken;
    const idToken = req.cookies.idToken;

    if (!token) {
      res.locals.user = null;
      return next();
    }

    const accessPayload = await getAccessVerifier().verify(token);
    const idPayload = idToken
      ? await getIdVerifier().verify(idToken).catch(() => null)
      : null;

    const user = {
      sub: accessPayload.sub,
      email: idPayload?.email || accessPayload.email,
      email_verified: idPayload?.email_verified,
      username: idPayload?.["cognito:username"] || accessPayload.username,
      name: idPayload?.name || idPayload?.given_name
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
