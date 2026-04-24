import express from "express";
import path from "path";
import url from "url";
import crypto from "crypto";

import { createSessionMiddleware } from "./services/sessionService.js";
import fileRoutes from "./routes/fileRoutes.js";
import workoutRoutes from "./routes/workoutRoutes.js"
import segmentRoutes from "./routes/segmentRoutes.js";
import collaborationRoutes from "./routes/collaborationRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import paymentsRoutes from "./routes/paymentsRoutes.js";

import { Issuer, generators } from "openid-client";
import { InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { ConfirmSignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import cookieParser from "cookie-parser";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import authGlobal from "./middleware/authGlobal.js";
import fs from "fs";

import uploadsRouter from './routes/uploads.js';
import importsRouter from './routes/imports.js';

let client;

export async function createApp() {

    const app = express();
    fs.mkdirSync("uploads", { recursive: true });

    const __filename = url.fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    app.set("trust proxy", 1);

    app.use(express.static(path.join(__dirname, "public")));
    app.use("/shared", express.static("src/shared"));
    const sessionMiddleware = await createSessionMiddleware();
    app.use(sessionMiddleware);
    //app.use(createSessionMiddleware());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(cookieParser());
    app.use(authGlobal);
    app.use((req, res, next) => {
        res.locals.currentUrl = req.originalUrl;
        next();
    });

    app.use("/files", fileRoutes);
    app.use("/workouts", workoutRoutes);

    app.use('/segments', segmentRoutes);
    app.use('/collaboration', collaborationRoutes);
    app.use('/api/profile', profileRoutes);
    app.use('/api/payments', paymentsRoutes);

    app.use('/api/uploads', uploadsRouter);
    app.use('/api/imports', importsRouter);


    app.use((err, req, res, next) => {
        console.error(err);
        res.status(500).json({
            error: err.message || 'Interner Serverfehler'
        });
    });

    app.set("views", path.join(__dirname, "views"));
    app.set("view engine", "ejs");


    // ---- Cognito Client initialisieren ----

    const issuerUrl =
        `https://cognito-idp.${process.env.COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`;

    const issuer = await Issuer.discover(issuerUrl);

    client = new issuer.Client({
        client_id: process.env.COGNITO_CLIENT_ID,
        client_secret: process.env.COGNITO_CLIENT_SECRET,
        redirect_uris: [process.env.COGNITO_REDIRECT_URI],
        response_types: ["code"]
    });

    const cognito = new CognitoIdentityProviderClient({
        region: "eu-central-1"
    });

    const verifier = CognitoJwtVerifier.create({
        userPoolId: process.env.COGNITO_USER_POOL_ID,
        tokenUse: "access",
        clientId: process.env.COGNITO_CLIENT_ID
    });



    // ---- Auth Helper ----

    const checkAuth = (req, res, next) => {
        req.isAuthenticated = !!req.session.userInfo;
        next();
    };

    const oauthCallbackPath = (() => {
        try {
            return new URL(process.env.COGNITO_REDIRECT_URI).pathname || "/auth/callback";
        } catch {
            return "/auth/callback";
        }
    })();

    const renderLogin = (res, redirect = "", error = null) => {
        res.render("login", {
            redirect,
            error
        });
    };

    const isSecureCookie = process.env.NODE_ENV === "production";

    const clearAuthCookies = (res) => {
        res.clearCookie("accessToken");
        res.clearCookie("refreshToken");
        res.clearCookie("idToken");
    };

    const normalizeReturnTo = (returnTo, fallback = "/") => {
        if (typeof returnTo !== "string" || !returnTo.startsWith("/") || returnTo.startsWith("//")) {
            return fallback;
        }

        return returnTo;
    };

    const decodeJwtPayload = (token) => {
        if (!token) {
            return null;
        }

        try {
            const [, payload] = token.split(".");

            if (!payload) {
                return null;
            }

            const normalized = payload
                .replace(/-/g, "+")
                .replace(/_/g, "/");
            const padded = normalized.padEnd(
                normalized.length + ((4 - normalized.length % 4) % 4),
                "="
            );

            return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        } catch (err) {
            console.warn("JWT decode failed:", err.message);
            return null;
        }
    };

    const pickInterestingClaims = (claims) => {
        if (!claims) {
            return null;
        }

        return {
            sub: claims.sub,
            email: claims.email,
            email_verified: claims.email_verified,
            cognito_username: claims["cognito:username"],
            identities: claims.identities,
            name: claims.name,
            given_name: claims.given_name,
            family_name: claims.family_name
        };
    };

    const logAuthTokenClaims = (label, accessToken, idToken) => {
        console.log(`[auth] ${label}`, {
            accessToken: pickInterestingClaims(decodeJwtPayload(accessToken)),
            idToken: pickInterestingClaims(decodeJwtPayload(idToken))
        });
    };

    const buildGoogleAuthorizeUrl = (state, nonce) => {
        const params = new URLSearchParams({
            identity_provider: "Google",
            redirect_uri: process.env.COGNITO_REDIRECT_URI,
            response_type: "code",
            client_id: process.env.COGNITO_CLIENT_ID,
            scope: "openid email",
            state,
            nonce
        });

        return `${process.env.COGNITO_DOMAIN}/oauth2/authorize?${params.toString()}`;
    };

    const exchangeCodeForTokens = async (code) => {
        const tokenUrl = `${process.env.COGNITO_DOMAIN}/oauth2/token`;
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: process.env.COGNITO_REDIRECT_URI
        });

        const headers = {
            "Content-Type": "application/x-www-form-urlencoded"
        };

        if (process.env.COGNITO_CLIENT_SECRET) {
            const basicAuth = Buffer
                .from(`${process.env.COGNITO_CLIENT_ID}:${process.env.COGNITO_CLIENT_SECRET}`)
                .toString("base64");
            headers.Authorization = `Basic ${basicAuth}`;
        } else {
            body.set("client_id", process.env.COGNITO_CLIENT_ID);
        }

        const response = await fetch(tokenUrl, {
            method: "POST",
            headers,
            body
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Token exchange failed (${response.status})`);
        }

        return response.json();
    };


    // ---- Routes ----

    app.get("/", async (req, res) => {
        if (!req.user?.id) {
            return res.render("home", {
                isAuthenticated: false,
                userInfo: null
            });
        }

        res.render("home", {
            isAuthenticated: true,
            userInfo: req.user
        });
    });

    app.post("/confirm", async (req, res) => {
        const { username, code } = req.body;
        try {



            const command = new ConfirmSignUpCommand({
                ClientId: process.env.COGNITO_CLIENT_ID,
                Username: username,
                ConfirmationCode: code
            });

            await cognito.send(command);

            return res.redirect("/login?confirmed=true");

        }
        catch (err) {
            console.error(err);

            return res.render("confirm", {
                username: username,
                error: 'Token expired or wrong'
            })
        }

    });

    app.post("/signup", async (req, res) => {

        const { email, password, username } = req.body;

        try {

            const command = new SignUpCommand({
                ClientId: process.env.COGNITO_CLIENT_ID,
                Username: username,
                Password: password,
                UserAttributes: [
                    { Name: "email", Value: email },
                    { Name: "name", Value: username }          // falls name required
                ]
            });

            await cognito.send(command);

            res.redirect(`/confirm?username=${encodeURIComponent(username)}`);

        } catch (err) {
            res.render("signup", {
                error: err.message
            });
        }

    });


    app.get("/login", async (req, res) => {
        const redirect = req.query.redirect || "";
        const token = req.cookies.accessToken;

        if (token) {
            try {
                await verifier.verify(token);
                return res.redirect("/");
            } catch {
                // absichtlich leer: dann normale Login-Seite rendern
            }
        }

        renderLogin(res, redirect);
    });

    app.get("/auth/google", (req, res, next) => {
        const redirect = req.query.redirect || "/";
        const state = crypto.randomUUID();
        const nonce = generators.nonce();

        clearAuthCookies(res);

        req.session.regenerate((err) => {
            if (err) {
                return next(err);
            }

            req.session.oauthState = state;
            req.session.oauthNonce = nonce;
            req.session.postLoginRedirect = redirect;

            req.session.save((saveErr) => {
                if (saveErr) {
                    return next(saveErr);
                }

                return res.redirect(buildGoogleAuthorizeUrl(state, nonce));
            });
        });
    });

    const handleOAuthCallback = async (req, res) => {
        const { code, state } = req.query;
        const expectedState = req.session.oauthState;
        const redirect = req.session.postLoginRedirect || "/";

        if (!code || !state || !expectedState || state !== expectedState) {
            return renderLogin(res, redirect, "Google login failed");
        }

        try {
            const tokens = await exchangeCodeForTokens(code);
            logAuthTokenClaims("google-login", tokens.access_token, tokens.id_token);
            clearAuthCookies(res);

            req.session.regenerate((sessionErr) => {
                if (sessionErr) {
                    console.error(sessionErr);
                    return renderLogin(res, redirect, "Google login failed");
                }

                res.cookie("accessToken", tokens.access_token, {
                    httpOnly: true,
                    secure: isSecureCookie
                });

                if (tokens.refresh_token) {
                    res.cookie("refreshToken", tokens.refresh_token, {
                        httpOnly: true,
                        secure: isSecureCookie
                    });
                }

                if (tokens.id_token) {
                    res.cookie("idToken", tokens.id_token, {
                        httpOnly: true,
                        secure: isSecureCookie
                    });
                }

                return res.redirect(redirect);
            });
        } catch (err) {
            console.error(err);
            return renderLogin(res, redirect, "Google login failed");
        }
    };

    app.get("/auth/callback", handleOAuthCallback);

    if (oauthCallbackPath !== "/auth/callback") {
        app.get(oauthCallbackPath, handleOAuthCallback);
    }


    app.post("/login", async (req, res) => {
        const redirect = req.body?.redirect || "";

        try {

            const { email, password } = req.body;

            console.log("[login] password-flow payload", {
                email,
                hasPassword: !!password,
                passwordLength: typeof password === "string" ? password.length : 0,
                redirect
            });

            const command = new InitiateAuthCommand({
                AuthFlow: "USER_PASSWORD_AUTH",
                ClientId: process.env.COGNITO_CLIENT_ID,
                AuthParameters: {
                    USERNAME: email,
                    PASSWORD: password
                }
            });

            const response = await cognito.send(command);

            const tokens = response.AuthenticationResult;
            logAuthTokenClaims("password-login", tokens.AccessToken, tokens.IdToken);
            const save_redirect = redirect || "/";
            clearAuthCookies(res);

            req.session.regenerate((sessionErr) => {
                if (sessionErr) {
                    console.error(sessionErr);
                    return renderLogin(res, redirect, "Login failed");
                }

                res.cookie("accessToken", tokens.AccessToken, {
                    httpOnly: true,
                    secure: isSecureCookie
                });

                res.cookie("refreshToken", tokens.RefreshToken, {
                    httpOnly: true,
                    secure: isSecureCookie
                });

                if (tokens.IdToken) {
                    res.cookie("idToken", tokens.IdToken, {
                        httpOnly: true,
                        secure: isSecureCookie
                    });
                }

                return res.redirect(save_redirect);
            });

            // hier redirect
            //res.redirect("/");
            /*res.json({
                success: true
            });*/

        }
        catch (err) {
            console.error(err);

            renderLogin(res, redirect, "Login failed");
        }

    });



    app.get("/signup", (req, res) => {
        res.render("signup")
    })

    app.get("/confirm", (req, res) => {
        res.render("confirm", {
            username: req.query.username,
            error: null
        })
    })


    app.get("/logout", (req, res) => {
        res.clearCookie("accessToken");
        res.clearCookie("refreshToken");
        res.clearCookie("idToken");

        req.session.destroy(() => {
            res.redirect("/");
        });
    });

    app.get("/impressum", (req, res) => {
        res.render("impressum", {
            returnTo: normalizeReturnTo(req.query.returnTo, req.user?.id ? "/" : "/login")
        });
    });

    app.get("/datenschutz", (req, res) => {
        res.render("datenschutz", {
            returnTo: normalizeReturnTo(req.query.returnTo, req.user?.id ? "/" : "/login")
        });
    });


    app.get("/dashboard", checkAuth, (req, res) => {

        if (!req?.user?.id) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("dashboard", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });

    app.get("/dashboard-new", checkAuth, (req, res) => {

        if (!req?.user?.id) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("dashboard-new", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });

    app.get("/analytics", checkAuth, (req, res) => {

        if (!req?.user?.id) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("analytics", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });    

    app.get("/groups", checkAuth, (req, res) => {

        if (!req?.user?.id) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("groups", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });

    app.get("/segments", checkAuth, (req, res) => {

        if (!req?.user?.id) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("segments", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });

    app.get("/profile", checkAuth, (req, res) => {

        if (!req?.user?.id) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("profile", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });


    return app;

}
