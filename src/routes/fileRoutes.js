import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import checkSessionMiddleware from "../middleware/checkSessionMiddleware.js";
import uploadMiddleware from "../middleware/uploadMiddleware.js";


import * as fileController from "../controllers/fileController.js";

import { FileDBService } from "../services/fileDBService.js";

const router = express.Router();


// POST /files/upload
router.post(
  '/upload',
  authMiddleware,
  uploadMiddleware.single('file'),
  fileController.uploadFile
);

/*const checkAuth = (req, res, next) => {
  if (!req.session.userInfo) {
    req.isAuthenticated = false;
  } else {
    req.isAuthenticated = true;
  }
  next();
};*/

router.delete("/workouts/:id", authMiddleware, async (req, res) => {
  const workoutId = req.params.id;
  const sub = req.user.sub;




  /*if (!Number.isInteger(workoutId) || workoutId <= 0) {
    return res.status(400).json({ error: "Invalid workout id" });
  }*/

  try {
    const result = await FileDBService.deleteWorkout(sub, workoutId);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Workout not found" });
    }
    return res.json({
      ok: true,
      id: workoutId
    });
  } catch (err) {
    console.error("DELETE /files/workouts/:id failed:", err);
    return res.status(500).json({ error: "Failed to delete workout" });
  }
});


router.get('/uploadUI', authMiddleware, async (req, res) => {
  console.log(req.user);
  //console.log(req.isAuthenticated);

  res.render('fileUpload', {
    userInfo: req.user,
    isAuthenticated: req.isAuthenticated
  });
});

// -------------------------------------
// GET /files/workouts  (Tabulator JSON)
// -------------------------------------
router.get("/workouts", authMiddleware, async (req, res, next) => {
  try {

    /*if (!req.session.userInfo) {
      return res.status(401).json({
        error: "Session expired"
      });
    }*/
    console.log("QUERY:", req.query);
    const page = parseInt(req.query.page || req.body.page) || 1;
    const size = parseInt(req.query.size || req.body.size) || 20;
    const sort = req.query.sort || [];
    const filters = req.query.filter || [];
    const authSub = req.user?.sub;

    const result = await FileDBService.getWorkoutsByUser(
      authSub,
      page,
      size,
      sort,
      filters
    );

    res.json(result);

  } catch (err) {
    next(err);
  }
});

// GET /files/workouts/:id/data
router.get("/workouts/:id/data", authMiddleware, async (req, res, next) => {
  try {
    /* if (!req.session.userInfo) {
       return res.status(401).json({
         error: "Session expired"
       });
     }*/
    const workoutId = req.params.id;
    const authSub = req.user?.sub;

    const url = await FileDBService.getWorkoutRecordsPreSignedUrl(
      workoutId,
      authSub
    );

    res.json({ url });

    /*const data = await FileDBService.getWorkoutRecords(
      workoutId,
      authSub
    );

    res.json(data);*/

  } catch (err) {
    next(err);
  }
});


export default router;