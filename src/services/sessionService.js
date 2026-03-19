/*import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pool from "./database.js";

const PgSession = connectPgSimple(session);

const sessionMiddleware = session({
  store: new PgSession({
    pool: pool,
    tableName: "user_sessions",
    pruneSessionInterval: 60 * 60,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    maxAge: 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  }
});

export default sessionMiddleware;*/
/*
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pool from "./database.js";

const PgSession = connectPgSimple(session);

export function createSessionMiddleware() {

  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not defined");
  }

  return session({
    store: new PgSession({
      pool: pool,
      tableName: "user_sessions",
      pruneSessionInterval: 60 * 60,
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      maxAge: 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    }
  });

}*/

import session from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";

const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on("error", (err) => {
  console.error("Redis session client error", err);
});

let redisConnectPromise = null;

async function ensureRedisConnected() {
  if (redisClient.isOpen) {
    return;
  }

  if (!redisConnectPromise) {
    redisConnectPromise = redisClient.connect().catch((err) => {
      redisConnectPromise = null;
      throw err;
    });
  }

  await redisConnectPromise;
}

export async function createSessionMiddleware() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not defined");
  }

  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not defined");
  }

  await ensureRedisConnected();

  return session({
    store: new RedisStore({
      client: redisClient,
      prefix: "sess:"
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      maxAge: 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    }
  });
}