const fs = require('fs');
const path = require('path');

require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

const pool = require('./services/database'); // dein Pool export

async function runMigrations() {
  try {
    const migrationFiles = fs
      .readdirSync(path.join(__dirname, 'migrations'))
      .sort();

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(
        path.join(__dirname, 'migrations', file),
        'utf8'
      );
      console.log(`Running migration: ${file}`);
      await pool.query(sql); // Hier wird der Pool verwendet
    }

    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end(); // Pool sauber schließen
  }
}

// Script starten
runMigrations();