import dotenv from "dotenv";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

console.log("ENV loaded:", process.env.NODE_ENV);