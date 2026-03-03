const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const checkSessionMiddleware = require('../middleware/checkSessionMiddleware');
const uploadMiddleware = require('../middleware/uploadMiddleware.js');
const fileController = require('../controllers/fileController');
const FileDBService = require("../services/fileDBService").FileDBService;


// POST /files/upload
router.post(
  '/upload',
  checkSessionMiddleware,
  uploadMiddleware.single('file'),
  fileController.uploadFile
);

const checkAuth = (req, res, next) => {
    if (!req.session.userInfo) {
        req.isAuthenticated = false;
    } else {
        req.isAuthenticated = true;
    }
    next();
};


router.get('/uploadUI', checkAuth, async (req, res) => {
    console.log(req.session.userInfo);    
    console.log(req.isAuthenticated);

    res.render('fileUpload', {
        userInfo: req.session.userInfo,
        isAuthenticated: req.isAuthenticated
    });
});

// -------------------------------------
// GET /files/workouts  (Tabulator JSON)
// -------------------------------------
router.get("/workouts", async (req, res, next) => {
  try {

    const page = parseInt(req.query.page) || 1;
    const size = parseInt(req.query.size) || 20;

    const authSub = req.session?.userInfo?.sub;

    const result = await FileDBService.getWorkoutsByUser(
      authSub,
      page,
      size
    );

    res.json(result);

  } catch (err) {
    next(err);
  }
});

// GET /files/workouts/:id/data
router.get("/workouts/:id/data", async (req, res, next) => {
  try {

    const workoutId = req.params.id;
    const authSub = req.session?.userInfo?.sub;

    const records = await FileDBService.getWorkoutRecords(
      workoutId,
      authSub
    );

    
    //res.json({} );
    res.json(records);

  } catch (err) {
    next(err);
  }
});


module.exports = router;