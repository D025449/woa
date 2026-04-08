import { CognitoJwtVerifier } from "aws-jwt-verify";
import UserDBService from "../services/userDBService.js"

let verifier;/* = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "access", // oder "access oder id"
  clientId: process.env.COGNITO_CLIENT_ID,
});*/

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: "access",
      clientId: process.env.COGNITO_CLIENT_ID,
    });
  }
  return verifier;
}

export default async function authGlobal(req, res, next) {

  try {

    // 🔥 1. Session hat Vorrang
    if (req.session?.user_id && req.session?.user?.sub) {
      req.user = {
        id: req.session.user_id,
        sub: req.session.user.sub,
        email: req.session?.user?.email
      };
      res.locals.user = req.user;
      return next();
    }

    // 🔥 2. Token holen
    const token = req.cookies.accessToken;

    if (!token) {
      return next();
    }

    const verifier = getVerifier();
    const payload = await verifier.verify(token);

    const user = {
      sub: payload.sub,
      email: payload.email,
      username: payload.username
    };

    // 🔥 3. DB Lookup NUR wenn keine Session
    const dbuser = await UserDBService.ensureUserExists(user);

    // 🔥 4. Session setzen (DER wichtige Schritt)
    req.session.user_id = dbuser.id;

    // optional: mehr Daten cachen
    req.session.user = {
      id: dbuser.id,
      sub: user.sub,
      email: dbuser.email
    };

    // 🔥 5. Request setzen
    req.user = {
      id: dbuser.id,
      sub: user.sub,
      email: user.email,
      username: user.username
    };

    res.locals.user = req.user;

    next();

  } catch (err) {

    console.warn("JWT verify failed:", err.message);

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