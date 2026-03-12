import express from "express";
import path from "path";
import url from "url";

import { createSessionMiddleware } from "./services/sessionService.js";
import fileRoutes from "./routes/fileRoutes.js";
import { ensureUserExists } from "./services/userDBService.js";
import { Issuer, generators } from "openid-client";

let client;

export async function createApp() {

    const app = express();

    const __filename = url.fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    app.set("trust proxy", 1);

    app.use(express.static(path.join(__dirname, "public")));

    app.use(createSessionMiddleware());

    app.use(express.json());

    app.use("/files", fileRoutes);

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


    // ---- Auth Helper ----

    const checkAuth = (req, res, next) => {
        req.isAuthenticated = !!req.session.userInfo;
        next();
    };


    // ---- Routes ----

    app.get("/", (req, res) => {

        if (!req.session.userInfo) {
            return res.render("home");
        }

        res.render("dashboard", {
            isAuthenticated: true,
            userInfo: req.session.userInfo
        });

    });


    app.get("/login", (req, res) => {

        const nonce = generators.nonce();
        const state = generators.state();

        req.session.nonce = nonce;
        req.session.state = state;

        const authUrl = client.authorizationUrl({
            scope: "email openid phone profile",
            state,
            nonce
        });

        res.redirect(authUrl);

    });


    app.get("/logout", (req, res) => {

        req.session.destroy();

        const logoutUrl =
            `${process.env.COGNITO_DOMAIN}/logout?` +
            `client_id=${process.env.COGNITO_CLIENT_ID}` +
            `&logout_uri=${process.env.APP_BASE_URL}`;

        res.redirect(logoutUrl);

    });


    app.get("/landing", async (req, res) => {

        try {

            const params = client.callbackParams(req);

            const tokenSet = await client.callback(
                process.env.COGNITO_REDIRECT_URI,
                params,
                {
                    nonce: req.session.nonce,
                    state: req.session.state
                }
            );

            const userInfo = await client.userinfo(tokenSet.access_token);

            req.session.userInfo = userInfo;
            req.session.userInfo.access_token = tokenSet.access_token;

            await ensureUserExists(req.session.userInfo);

            res.redirect("/dashboard");

        } catch (err) {

            console.error("Callback error:", err);
            res.redirect("/");

        }

    });


    app.get("/dashboard", checkAuth, (req, res) => {

        if (!req.session.userInfo) {
            return res.redirect("/");
        }

        res.render("dashboard", {
            userInfo: req.session.userInfo,
            isAuthenticated: true
        });

    });


    return app;

}