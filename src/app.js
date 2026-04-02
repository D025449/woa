import express from "express";
import path from "path";
import url from "url";

import { createSessionMiddleware } from "./services/sessionService.js";
import fileRoutes from "./routes/fileRoutes.js";
import segmentRoutes from "./routes/segmentRoutes.js";

//import { ensureUserExists } from "./services/userDBService.js";
import { Issuer, generators } from "openid-client";
import { InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { ConfirmSignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import cookieParser from "cookie-parser";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import authGlobal from "./middleware/authGlobal.js";
import { progressEmitter } from "./services/progressEmitter.js";
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

    app.use("/files", fileRoutes);
    app.use('/segments', segmentRoutes);

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


    // ---- Routes ----

    app.get("/", async (req, res) => {
        const token = req.cookies.accessToken;

        if (!token) {
            return res.redirect("/login");
        }

        try {

            const payload = await verifier.verify(token);

            res.render("dashboard", {
                isAuthenticated: true,
                userInfo: payload
            });

        } catch (err) {

            res.redirect("/login");

        }

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


    app.get("/login", (req, res) => {
        const redirect = req.query.redirect || "";
        res.render("login", {
            redirect
        });
    });


    app.post("/login", async (req, res) => {

        try {

            const { email, password, redirect } = req.body;

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

            res.cookie("accessToken", tokens.AccessToken, {
                httpOnly: true,
                secure: true
            });

            res.cookie("refreshToken", tokens.RefreshToken, {
                httpOnly: true,
                secure: true
            });

            const save_redirect = redirect || "/dashboard";

            return res.redirect(save_redirect);

            // hier redirect
            //res.redirect("/");
            /*res.json({
                success: true
            });*/

        }
        catch (err) {
            console.error(err);

            res.render("login", {
                error: "Login failed"
            });
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
        res.clearCookie("accessToken")
        res.clearCookie("refreshToken")
        res.redirect("/login")
    });


    app.get("/dashboard", checkAuth, (req, res) => {

        if (!req?.user?.sub) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("dashboard", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });

    app.get("/analytics", checkAuth, (req, res) => {

        if (!req?.user?.sub) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("analytics", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });    

    app.get("/segments", checkAuth, (req, res) => {

        if (!req?.user?.sub) {
            const redirectUrl = encodeURIComponent(req.originalUrl);
            return res.redirect(`/login?redirect=${redirectUrl}`);
        }

        res.render("segments", {
            userInfo: req.user,
            isAuthenticated: true
        });

    });


    return app;

}