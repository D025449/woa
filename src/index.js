import "./config/env.js";

import { createApp } from "./app.js";

async function start() {

  const app = await createApp();

  const PORT = process.env.PORT || 3000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

}

start();


/*import dotenv from "dotenv";
dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}`});
import express from 'express';
import path from "path";
import url from "url";
import { Issuer, generators } from "openid-client"


//import sessionMiddleware from "./services/sessionService.js";
import { createSessionMiddleware } from "./services/sessionService.js";
//import db from "./services/database.js";
import fileRoutes from "./routes/fileRoutes.js";
import { ensureUserExists } from "./services/userDBService.js";

const app = express();//.default;

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, "public")));





app.use(createSessionMiddleware());



console.log(process.env.NODE_ENV);

let client;
// Initialize OpenID Client
async function initializeClient() {

    const issuerUrl = `https://cognito-idp.${process.env.COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`;
    console.log("initializeClient IssuerURL " + issuerUrl);
    console.log("ClientID " + process.env.COGNITO_CLIENT_ID);
//    console.log("ClientScret " + process.env.COGNITO_CLIENT_SECRET);
    console.log("ClientRedirect URI " + process.env.COGNITO_REDIRECT_URI);


    const issuer = await Issuer.discover(issuerUrl);
    client = new issuer.Client({
        client_id: process.env.COGNITO_CLIENT_ID,
        client_secret: process.env.COGNITO_CLIENT_SECRET,  // Optional, nur wenn nötig
        redirect_uris: [process.env.COGNITO_REDIRECT_URI],
        response_types: ['code']
    });
};




app.use(express.json());

app.use('/files', fileRoutes);


console.log(process.env.SESSION_SECRET);



//ejs
app.set("views", path.join(__dirname, "views")); // __dirname = src/
app.set("view engine", 'ejs');

//routes

const checkAuth = (req, res, next) => {
    if (!req.session.userInfo) {
        req.isAuthenticated = false;
    } else {
        req.isAuthenticated = true;
    }
    next();
};


app.get('/', (req, res) => {
    if (!req.session.userInfo) {
        return res.render('home'); // NICHT automatisch redirecten
    }
    req.isAuthenticated = true;

    console.log("Rendering dashboard with userInfo:", req.session.userInfo);
    res.render('dashboard', {
        isAuthenticated: req.isAuthenticated,
        userInfo: req.session.userInfo
    });
});



app.get('/login', (req, res) => {
    const nonce = generators.nonce();
    const state = generators.state();

    req.session.nonce = nonce;
    req.session.state = state;

    const authUrl = client.authorizationUrl({
        scope: 'email openid phone profile',
        state: state,
        nonce: nonce,
    });

 //   console.log("In login authUrl " + authUrl);

    res.redirect(authUrl);
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy();
    const logoutUrl = `${process.env.COGNITO_DOMAIN}/logout?` +
        `client_id=${process.env.COGNITO_CLIENT_ID}` +
        `&logout_uri=${process.env.APP_BASE_URL}`;

 //   console.log("LogoutUrl " + logoutUrl);
    res.redirect(logoutUrl);
});

app.get('/landing', async (req, res) => {
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
//        console.log(userInfo);

        req.session.userInfo = userInfo;
        req.session.userInfo.access_token = tokenSet.access_token;
        const userId = await ensureUserExists(req.session.userInfo);


        res.redirect('/dashboard');
    } catch (err) {
        console.error('Callback error:', err);
        res.redirect('/');
    }
});


app.get('/dashboard', checkAuth, async (req, res) => {
    if (!req.session.userInfo) {
        res.redirect('/');
        //return res.render('home'); // NICHT automatisch redirecten
    }
    console.log(req.session.userInfo);
    res.render('dashboard', {
        userInfo: req.session.userInfo,
        isAuthenticated: req.isAuthenticated
    });
});


//port
initializeClient().then(() => { app.listen(3000, "0.0.0.0", () => { console.log("Listening at port 3000...") }) });


*/