import pool from "../services/database.js";

export default async function requireAdmin(req, res, next) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const result = await pool.query(`
      SELECT 1
      FROM user_roles
      WHERE uid = $1 AND role = 'admin'
      LIMIT 1
    `, [req.user.id]);
    if (result.rowCount === 0) {
      return res.status(403).json({ error: "Admin role required" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
