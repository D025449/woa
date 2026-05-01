export default function requireActiveAccountWrite(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.user.account_status === "pending_deletion") {
    return res.status(423).json({
      error: "Account is scheduled for deletion. Cancel deletion to enable write actions again.",
      code: "account_pending_deletion",
      deletionScheduledFor: req.user.deletion_scheduled_for || null
    });
  }

  if (req.user.account_status === "deleted") {
    return res.status(403).json({
      error: "Account is no longer active.",
      code: "account_deleted"
    });
  }

  return next();
}
