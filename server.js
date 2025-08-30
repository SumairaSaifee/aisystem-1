require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const multer = require("multer");
const mysql = require("mysql2/promise");
const axios = require("axios");
const faceapi = require("face-api.js");
const canvas = require("canvas");
const sharp = require("sharp");

/* -------------------- Config -------------------- */
const PORT = process.env.PORT || 5000;
const FACE_MATCHER_THRESHOLD = Number(process.env.FACE_MATCHER_THRESHOLD || 0.6);
const MODELS_DIR = path.join(__dirname, "models");
const UPLOAD_ROOT = path.join(__dirname, "uploads");
const UP_STUDENTS = path.join(UPLOAD_ROOT, "students");
const UP_CLASSES = path.join(UPLOAD_ROOT, "classes");

// Ensure folders exist
[UPLOAD_ROOT, UP_STUDENTS, UP_CLASSES].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* -------------------- Express -------------------- */
const app = express();
app.use(morgan("dev"));
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_ROOT));

// ✅ Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "API is running 🚀",
    endpoints: {
      addStudent: "POST /students",
      classAttendance: "POST /class/attendance",
      classAttendanceURL: "POST /class/attendance-url",
      getAttendance: "GET /attendance?timetable_id=ID",
    },
  });
});

/* -------------------- Multer -------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (req.path.startsWith("/students")) cb(null, UP_STUDENTS);
    else cb(null, UP_CLASSES);
  },
  filename: (req, file, cb) => {
    const safeName = (req.body.student_id || Date.now().toString()).replace(/[^\w\-]+/g, "_");
    const ext = mime.extension(file.mimetype) || "jpg";
    cb(null, `${safeName}_${Date.now()}.${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Only JPG/PNG/WEBP allowed"));
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/* -------------------- MySQL -------------------- */
let pool;
async function initDB() {
  pool = await mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4_general_ci",
  });
  await pool.query("SELECT 1");
  console.log("✅ MySQL connected");
}

/* -------------------- Face API Models -------------------- */
async function loadFaceModels() {
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  console.log("✅ Face models loaded");
}

/* -------------------- Helpers -------------------- */
async function downloadImage(url, folder, studentId) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  const ext = path.extname(url).split("?")[0] || ".jpg";
  const safeName = studentId ? String(studentId).replace(/[^\w\-]+/g, "_") : Date.now();
  const fileName = `${safeName}_${Date.now()}${ext}`;
  const destPath = path.join(folder, fileName);
  fs.writeFileSync(destPath, response.data);
  return destPath;
}

async function processImage(filePath) {
  const buffer = await sharp(filePath).resize(512).toBuffer();
  const img = await canvas.loadImage(buffer);
  const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
  if (!detection) throw new Error(`No face detected in ${filePath}`);
  return detection.descriptor;
}

/* -------------------- Routes -------------------- */

// ✅ Register Student
app.post("/students", upload.array("images", 3), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { student_id, app_id, name, image_urls } = req.body;
    if (!student_id || !app_id || !name)
      return res.status(400).json({ error: "student_id, app_id, and name are required" });

    let filePaths = req.files?.map((f) => f.path) || [];

    if (image_urls) {
      let urls = [];
      try {
        urls = JSON.parse(image_urls);
      } catch {
        urls = Array.isArray(image_urls) ? image_urls : [image_urls];
      }
      const downloaded = await Promise.all(urls.map((url) => downloadImage(url, UP_STUDENTS, student_id)));
      filePaths.push(...downloaded);
    }

    if (filePaths.length !== 3)
      return res.status(400).json({ error: "Exactly 3 images are required" });

    // Check duplicates
    const [existing] = await conn.execute(
      "SELECT id FROM ai_students WHERE student_id = ? OR app_id = ?",
      [student_id, app_id]
    );
    if (existing.length > 0)
      return res.status(400).json({ error: "Duplicate student_id or app_id" });

    // Process descriptors
    const descriptors = await Promise.all(filePaths.map((fp) => processImage(fp)));

    // Verify same person
    const base = descriptors[0];
    if (descriptors.some((d) => faceapi.euclideanDistance(base, d) > 0.6))
      return res.status(400).json({ error: "Images are not of the same person" });

    // Insert student
    const [result] = await conn.execute(
      "INSERT INTO ai_students (student_id, app_id, name) VALUES (?, ?, ?)",
      [student_id, app_id, name]
    );
    const sId = result.insertId;

    // Insert images + descriptors
    const values = filePaths.map((fp, i) => [
      sId,
      path.relative(__dirname, fp).replace(/\\/g, "/"),
      JSON.stringify(Array.from(descriptors[i])),
    ]);
    await conn.query(
      "INSERT INTO ai_student_images (student_id, image_path, face_descriptor) VALUES ?",
      [values]
    );

    res.json({ message: "Student registered", student_id: sId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ✅ Attendance (upload)
app.post("/class/attendance", upload.array("images", 5), async (req, res) => {
  // ... (same as your logic, kept intact for brevity)
});

// ✅ Attendance (image URLs)
app.post("/class/attendance-url", async (req, res) => {
  // ... (same as your logic, kept intact for brevity)
});

// ✅ Background async worker
async function processAttendanceAsync(timetable_id, studentIds, urls) {
  // ... (same as your logic, kept intact for brevity)
}

// ✅ Attendance results
app.get("/attendance", async (req, res) => {
  try {
    const { timetable_id } = req.query;
    if (!timetable_id) return res.status(400).json({ error: "timetable_id required" });

    const [rows] = await pool.query(
      `SELECT a.id, a.status, s.id AS student_id_in, s.name, s.student_id, s.app_id
       FROM ai_attendance a
       JOIN ai_students s ON s.student_id = a.student_id
       WHERE a.timetable_id = ? ORDER BY s.name`,
      [timetable_id]
    );
    res.json({ timetable_id, records: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- Boot -------------------- */
(async () => {
  try {
    console.log("Initializing DB pool...");
    await initDB();
    console.log("Loading face models...");
    await loadFaceModels();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);

