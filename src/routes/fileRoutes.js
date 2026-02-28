const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const checkSessionMiddleware = require('../middleware/checkSessionMiddleware');
const uploadMiddleware = require('../middleware/uploadMiddleware.js');
const fileController = require('../controllers/fileController');

// POST /files/upload
router.post(
  '/upload',
  checkSessionMiddleware,
  uploadMiddleware.single('file'),
  fileController.uploadFile
);

module.exports = router;