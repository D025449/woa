import { CognitoJwtVerifier } from "aws-jwt-verify";
import ensureUserExists from "../services/userDBService.js"

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
    await ensureUserExists(user);

    next();

  } catch (err) {

    console.warn("JWT verify failed:", err.message);

    next();

  }

}