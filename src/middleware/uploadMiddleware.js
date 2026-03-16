import multer from "multer";

//const memStorage = multer.memoryStorage();
const fileStorage = {
  dest: "uploads/",
  limits: {
    fileSize: 200 * 1024 * 1024
  }
};

export default multer( fileStorage );