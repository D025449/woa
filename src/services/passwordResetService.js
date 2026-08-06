import crypto from "crypto";
import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand
} from "@aws-sdk/client-cognito-identity-provider";

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION || "eu-central-1"
});

export function buildPasswordResetSecretHash(
  username,
  clientId = process.env.COGNITO_CLIENT_ID,
  clientSecret = process.env.COGNITO_CLIENT_SECRET
) {
  if (!username || !clientId || !clientSecret) return undefined;
  return crypto
    .createHmac("sha256", clientSecret)
    .update(`${username}${clientId}`)
    .digest("base64");
}

function buildBaseInput(username) {
  const input = {
    ClientId: process.env.COGNITO_CLIENT_ID,
    Username: username
  };
  const secretHash = buildPasswordResetSecretHash(username);
  if (secretHash) input.SecretHash = secretHash;
  return input;
}

export async function requestPasswordReset(username, client = cognitoClient) {
  return client.send(new ForgotPasswordCommand(buildBaseInput(username)));
}

export async function confirmPasswordReset(
  { username, confirmationCode, password },
  client = cognitoClient
) {
  return client.send(new ConfirmForgotPasswordCommand({
    ...buildBaseInput(username),
    ConfirmationCode: confirmationCode,
    Password: password
  }));
}
