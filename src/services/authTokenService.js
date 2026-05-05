import crypto from "crypto";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION || "eu-central-1"
});

function isSecureCookie() {
  return process.env.NODE_ENV === "production";
}

function applyPadding(value) {
  return value.padEnd(value.length + ((4 - value.length % 4) % 4), "=");
}

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
    return JSON.parse(Buffer.from(applyPadding(normalized), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function buildSecretHash(username) {
  if (!process.env.COGNITO_CLIENT_SECRET || !username) {
    return undefined;
  }

  return crypto
    .createHmac("sha256", process.env.COGNITO_CLIENT_SECRET)
    .update(`${username}${process.env.COGNITO_CLIENT_ID}`)
    .digest("base64");
}

export function clearAuthCookies(res) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
  res.clearCookie("idToken");
}

export function setAuthCookies(res, tokens = {}, preserveRefreshToken = null) {
  const secure = isSecureCookie();

  if (tokens.accessToken) {
    res.cookie("accessToken", tokens.accessToken, {
      httpOnly: true,
      secure
    });
  }

  if (tokens.refreshToken || preserveRefreshToken) {
    res.cookie("refreshToken", tokens.refreshToken || preserveRefreshToken, {
      httpOnly: true,
      secure
    });
  }

  if (tokens.idToken) {
    res.cookie("idToken", tokens.idToken, {
      httpOnly: true,
      secure
    });
  }
}

export async function refreshAccessTokens(refreshToken, fallbackUsername = "") {
  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }

  const authParameters = {
    REFRESH_TOKEN: refreshToken
  };

  const secretHash = buildSecretHash(fallbackUsername);
  if (secretHash) {
    authParameters.SECRET_HASH = secretHash;
    authParameters.USERNAME = fallbackUsername;
  }

  const command = new InitiateAuthCommand({
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: process.env.COGNITO_CLIENT_ID,
    AuthParameters: authParameters
  });

  const response = await cognitoClient.send(command);
  const tokens = response?.AuthenticationResult || {};
  const accessToken = tokens.AccessToken || "";
  const idToken = tokens.IdToken || "";
  const idPayload = decodeJwtPayload(idToken);

  return {
    accessToken,
    idToken,
    refreshToken,
    idPayload
  };
}
