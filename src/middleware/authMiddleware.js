import { CognitoJwtVerifier } from "aws-jwt-verify";

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


export default async function authMiddleware(req, res, next) {
  try {
    /*const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }*/
    if (req?.user?.id) {
      return next();

    }

    const token = req.cookies.accessToken;

    if (!token) {
      res.locals.user = null;
      return next();
    }

    //const token = authHeader.split(" ")[1];
    verifier = getVerifier();

    const payload = await verifier.verify(token);

    const user = {
      sub: payload.sub,
      email: payload.email,
      username: payload.username
    };

    // 🔥 3. DB Lookup NUR wenn keine Session
    const dbuser = await UserDBService.ensureUserExists(user);


    // WICHTIG:
    req.user = {
      id: dbuser.id,
      sub: payload.sub,
      email: payload.email,
      username: payload.username
    };

    next();

  } catch (err) {
    console.error("JWT verification failed:", err);
    return res.status(401).json({ error: "Invalid token" });
  }
};