const { CognitoJwtVerifier } = require("aws-jwt-verify");

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "access", // oder "access oder id"
  clientId: process.env.COGNITO_CLIENT_ID,
});

module.exports = async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    const payload = await verifier.verify(token);

    // WICHTIG:
    req.user = {
      sub: payload.sub,
      email: payload.email
    };

    next();

  } catch (err) {
    console.error("JWT verification failed:", err);
    return res.status(401).json({ error: "Invalid token" });
  }
};