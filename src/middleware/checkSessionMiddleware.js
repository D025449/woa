

module.exports = async function checkSession(req, res, next) {
  if (!req.session.userInfo) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}