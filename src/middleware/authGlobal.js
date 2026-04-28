import { CognitoJwtVerifier } from "aws-jwt-verify";
import UserDBService from "../services/userDBService.js"

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

export default async function authGlobal(req, res, next) {

  try {

    // Der aktuelle Token hat Vorrang vor einer möglicherweise alten Session.
    const token = req.cookies.accessToken;
    const idToken = req.cookies.idToken;

    if (!token && req.session?.user_id && req.session?.user?.sub) {
      req.user = {
        id: req.session.user_id,
        sub: req.session.user.sub,
        email: req.session?.user?.email,
        language: req.session?.user?.language || "en"
      };
      res.locals.user = req.user;
      return next();
    }

    if (!token) {
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
    const language = await UserDBService.getUserLanguage(dbuser.id);

    // Session immer auf den gerade verifizierten Token synchronisieren.
    req.session.user_id = dbuser.id;
    req.session.user = {
      id: dbuser.id,
      sub: user.sub,
      email: dbuser.email,
      display_name: dbuser.display_name,
      language
    };

    // 🔥 5. Request setzen
    req.user = {
      id: dbuser.id,
      sub: user.sub,
      email: dbuser.email,
      username: user.username,
      display_name: dbuser.display_name,
      language
    };

    res.locals.user = req.user;

    next();

  } catch (err) {

    console.warn("JWT verify failed:", err.message);

    if (req.session?.user_id || req.session?.user) {
      delete req.session.user_id;
      delete req.session.user;
    }

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
