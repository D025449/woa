const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./database'); // dein Postgres-Pool

const sessionMiddleware = session({
    store: new pgSession({
        pool: pool,
        tableName: 'user_sessions',
        pruneSessionInterval: 60 * 60, // alle 60 Minuten alte Sessions löschen
        createTableIfMissing: true  // ← erzeugt die Tabelle automatisch
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,               // verlängert Session bei Aktivität
    cookie: {
        httpOnly: true,
        maxAge: 60 * 60 * 1000, // one hour
        secure: false,//process.env.NODE_ENV === "production",   // ❗ bei localhost muss false sein
        sameSite: 'lax'

    }
});

module.exports = sessionMiddleware;