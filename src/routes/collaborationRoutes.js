import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import CollaborationDBService from "../services/collaborationDBService.js";
import SegmentDBService from "../services/segmentDBService.js";
import { enqueueSegmentBestEfforts } from "../services/segment-best-efforts-service.js";
import WorkoutSharingService from "../services/workoutSharingService.js";

const router = express.Router();

router.get("/groups", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.listGroupsForUser(req.user.id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/groups", authMiddleware, async (req, res, next) => {
  try {
    const group = await CollaborationDBService.createGroup(req.user.id, req.body);
    res.status(201).json({ data: group });
  } catch (err) {
    next(err);
  }
});

router.put("/groups/:groupId", authMiddleware, async (req, res, next) => {
  try {
    const group = await CollaborationDBService.updateGroup(
      req.user.id,
      Number(req.params.groupId),
      req.body
    );
    res.json({ data: group });
  } catch (err) {
    next(err);
  }
});

router.get("/groups/:groupId", authMiddleware, async (req, res, next) => {
  try {
    const detail = await CollaborationDBService.getGroupDetailForUser(
      req.user.id,
      Number(req.params.groupId)
    );
    res.json({ data: detail });
  } catch (err) {
    next(err);
  }
});

router.post("/groups/:groupId/leave", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.leaveGroup(
      req.user.id,
      Number(req.params.groupId)
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.delete("/groups/:groupId", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.deleteGroup(
      req.user.id,
      Number(req.params.groupId)
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/groups/:groupId/invites", authMiddleware, async (req, res, next) => {
  try {
    const invite = await CollaborationDBService.createInvite(
      req.user.id,
      Number(req.params.groupId),
      req.body
    );
    res.status(201).json({ data: invite });
  } catch (err) {
    next(err);
  }
});

router.post("/groups/:groupId/publish", authMiddleware, async (req, res, next) => {
  try {
    const groupId = Number(req.params.groupId);
    const contentType = String(req.body?.contentType || "").toLowerCase();

    if (contentType === "workouts") {
      const data = await WorkoutSharingService.bulkPublishWorkoutsToGroup(
        req.user.id,
        groupId,
        req.body?.preset
      );

      if (Array.isArray(data.workouts) && data.workouts.length > 0) {
        await Promise.all(
          data.workouts.map((workout) =>
            CollaborationDBService.createWorkoutUploadedFeedEvents({
              groupIds: [groupId],
              actorUserId: req.user.id,
              workoutId: Number(workout.id),
              payload: {
                startTime: workout.start_time,
                totalDistance: workout.total_distance,
                totalTimerTime: workout.total_timer_time
              }
            })
          )
        );
      }

      const targets = await SegmentDBService.getSharedSegmentRescanTargetsForGroup(groupId);
      const groupedTargets = targets.reduce((acc, target) => {
        const ownerId = String(target.uid);
        if (!acc.has(ownerId)) {
          acc.set(ownerId, []);
        }
        acc.get(ownerId).push(target.id);
        return acc;
      }, new Map());

      await Promise.all(
        [...groupedTargets.entries()].map(([ownerId, segmentIds]) =>
          enqueueSegmentBestEfforts({
            uid: Number(ownerId),
            segmentIds
          })
        )
      );

      return res.json({ data });
    }

    if (contentType === "segments") {
      const data = await SegmentDBService.bulkPublishSegmentsToGroup(req.user.id, groupId);

      if (Array.isArray(data.segments) && data.segments.length > 0) {
        await Promise.all(
          data.segments.map((segment) =>
            CollaborationDBService.createSegmentPublishedFeedEvents({
              groupIds: [groupId],
              actorUserId: req.user.id,
              segmentId: Number(segment.id),
              payload: {
                segmentType: "gps",
                distance: segment.distance ?? null,
                duration: segment.duration ?? null,
                startName: segment.start_name || null,
                endName: segment.end_name || null
              }
            })
          )
        );

        await enqueueSegmentBestEfforts({
          uid: req.user.id,
          segmentIds: data.segmentIds
        });
      }

      return res.json({ data });
    }

    return res.status(400).json({ error: "Invalid publish content type" });
  } catch (err) {
    next(err);
  }
});

router.get("/invites", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.listInvitesForUser(req.user.id, {
      status: req.query.status
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/invites/sent", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.listSentInvitesForUser(req.user.id, {
      status: req.query.status
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/feed", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.listFeedForUser(req.user.id, {
      limit: req.query.limit,
      range: req.query.range,
      actorScope: req.query.actorScope
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/feed/:feedEventId/dismiss", authMiddleware, async (req, res, next) => {
  try {
    const data = await CollaborationDBService.dismissFeedEventForUser(
      req.user.id,
      Number(req.params.feedEventId)
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/invites/:inviteId/accept", authMiddleware, async (req, res, next) => {
  try {
    const result = await CollaborationDBService.respondToInvite(
      req.user.id,
      Number(req.params.inviteId),
      "accept"
    );

    const acceptedGroupId = Number(result?.invite?.group_id);
    if (Number.isInteger(acceptedGroupId) && acceptedGroupId > 0) {
      try {
        const targets = await SegmentDBService.getSharedSegmentRescanTargetsForGroup(acceptedGroupId);
        const groupedTargets = targets.reduce((acc, target) => {
          const ownerId = String(target.uid);
          if (!acc.has(ownerId)) {
            acc.set(ownerId, []);
          }
          acc.get(ownerId).push(target.id);
          return acc;
        }, new Map());

        await Promise.all(
          [...groupedTargets.entries()].map(([ownerId, segmentIds]) =>
            enqueueSegmentBestEfforts({
              uid: Number(ownerId),
              segmentIds
            })
          )
        );
      } catch (queueErr) {
        console.error("POST /collaboration/invites/:inviteId/accept rescan enqueue failed:", queueErr);
      }
    }

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post("/invites/:inviteId/decline", authMiddleware, async (req, res, next) => {
  try {
    const result = await CollaborationDBService.respondToInvite(
      req.user.id,
      Number(req.params.inviteId),
      "decline"
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post("/invites/:inviteId/revoke", authMiddleware, async (req, res, next) => {
  try {
    const result = await CollaborationDBService.revokeInvite(
      req.user.id,
      Number(req.params.inviteId)
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.post("/invites/:inviteId/dismiss-sent", authMiddleware, async (req, res, next) => {
  try {
    const result = await CollaborationDBService.dismissSentInviteForUser(
      req.user.id,
      Number(req.params.inviteId)
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message
    });
  }

  console.error("collaboration route failed:", err);
  return res.status(500).json({
    error: err?.message || "Collaboration request failed"
  });
});

export default router;
