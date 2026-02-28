
const pool = require('./database'); // dein Postgres-Pool

async function ensureUserExists(userInfo) {
  const { sub, email, email_verified, name } = userInfo;

  await pool.query(`
    INSERT INTO users (auth_sub, email, email_verified, display_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (auth_sub)
    DO UPDATE SET
      email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      display_name = EXCLUDED.display_name
  `, [sub, email, email_verified, name]);
}
module.exports = {
  ensureUserExists
};