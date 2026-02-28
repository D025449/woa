const express = require('express');
const path = require("path");
const app = express();
const request = require('request');
const wikip = require('wiki-infobox-parser');
const multer = require('multer');
const fitParser = require('fit-file-parser').default;
const { randomUUID } = require('crypto');

app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, "public")));

const session = require('express-session');
const { Issuer, generators } = require('openid-client');

require("dotenv").config({
    path: `.env.${process.env.NODE_ENV || "development"}`
});
const {ensureUserExists} = require("./services/userDBService" );


/*
🏗️ Denkmodell, das dir ab jetzt hilft
Merksatz:
Alles, was req erweitert, muss VOR allem stehen, was es benutzt.
Beispiele:
Middleware	Muss vor…
session()	allen Routen
bodyParser()	POST-Handlern
passport.initialize()	auth routes
cors()	allen APIs
express.json()	JSON-Handlern
*/

const sessionMiddleware = require('./services/sessionService');

app.use(sessionMiddleware);

const db = require("./services/database");

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


const fileRoutes = require('./routes/fileRoutes');

app.use(express.json());

app.use('/files', fileRoutes);


const upload = multer();

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

    //const result = await db.query("SELECT NOW()");
    //console.log(result.rows[0]);
    console.log(req.session.userInfo);
    res.render('dashboard', {
        userInfo: req.session.userInfo,
        isAuthenticated: req.isAuthenticated
    });
});


//port
initializeClient().then(() => { app.listen(3000, "0.0.0.0", () => { console.log("Listening at port 3000...") }) });