require("dotenv").config();

const express = require("express");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const multer = require("multer");
const mysql = require("mysql2/promise");

const faceapi = require("face-api.js");
const canvas = require("canvas");
const { Canvas, Image, ImageData, loadImage } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

/* -------------------- Config -------------------- */
const PORT = process.env.PORT || 3000;
const FACE_MATCHER_THRESHOLD = Number(process.env.FACE_MATCHER_THRESHOLD || 0.6);
const MODELS_DIR = path.join(__dirname, "models");
const UPLOAD_ROOT = path.join(__dirname, "uploads");
const UP_STUDENTS = path.join(UPLOAD_ROOT, "students");
const UP_CLASSES  = path.join(UPLOAD_ROOT, "classes");

// Ensure folders exist
[UPLOAD_ROOT, UP_STUDENTS, UP_CLASSES].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* -------------------- Multer (disk) */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (req.path.startsWith("/students")) cb(null, UP_STUDENTS);
    else cb(null, UP_CLASSES);
  },
  filename: (req, file, cb) => {
    const safeName = (req.body.student_id || Date.now().toString()).replace(/[^\w\-]+/g, "_");
    const ext = mime.extension(file.mimetype) || "jpg";
    cb(null, `${safeName}_${Date.now()}.${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg","image/png","image/webp"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Only JPG/PNG/WEBP allowed"));
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

/* -------------------- MySQL -------------------- */
let pool;
async function initDB() {
  pool = await mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,      
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4_general_ci"
  });
  await pool.query("SELECT 1");
}

/* -------------------- Face API Models -------------------- */
async function loadFaceModels() {
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  console.log("Face models loaded.");
}

/* -------------------- Helpers -------------------- */
async function imageToDescriptor(imagePath) {
  const img = await loadImage(imagePath);
  const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
  if (!detection) throw new Error("No face detected in the image. Upload a clear front-facing photo.");
  return Array.from(detection.descriptor);
}

/* -------------------- App -------------------- */
const app = express();
app.use(morgan("dev"));
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_ROOT));

/* -------------------- Routes -------------------- */

// Add Student with single-face & same-person validation
app.post("/students", upload.array("images", 3), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { student_id, app_id, name } = req.body;
    if (!student_id || !app_id || !name)
      return res.status(400).json({ error: "student_id, app_id, and name are required" });

    if (!req.files || req.files.length !== 3)
      return res.status(400).json({ error: "Exactly 3 images are required" });

    // Duplicate check
    const [existing] = await conn.execute(
      "SELECT id FROM ai_students WHERE student_id = ? OR app_id = ?",
      [student_id, app_id]
    );
    if (existing.length > 0)
      return res.status(400).json({ error: "Duplicate student_id or app_id detected" });

    const descriptors = [];

    for (const file of req.files) {
      const img = await loadImage(file.path);
      // Detect all faces
      const detections = await faceapi.detectAllFaces(img).withFaceLandmarks();

      if (detections.length === 0)
        return res.status(400).json({ error: `No face detected in ${file.originalname}` });

      if (detections.length > 1)
        return res.status(400).json({ error: `Multiple faces detected in ${file.originalname}. Upload only a single face.` });

      // Get descriptor for the single face
      const descriptorObj = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
      descriptors.push(descriptorObj.descriptor);
    }

    // Validate that all descriptors belong to the same person
    const baseDescriptor = descriptors[0];
    for (let i = 1; i < descriptors.length; i++) {
      const distance = faceapi.euclideanDistance(baseDescriptor, descriptors[i]);
      if (distance > 0.6) {
        return res.status(400).json({ error: "Uploaded images are not of the same person" });
      }
    }

    // Insert student
    const [result] = await conn.execute(
      "INSERT INTO ai_students (student_id, app_id, name) VALUES (?, ?, ?)",
      [student_id, app_id, name]
    );
    const sId = result.insertId;

    // Insert images into DB
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const imagePath = path.relative(__dirname, file.path).replace(/\\/g, "/");
      await conn.execute(
        "INSERT INTO ai_student_images (student_id, image_path, face_descriptor) VALUES (?, ?, ?)",
        [sId, imagePath, JSON.stringify(Array.from(descriptors[i]))]
      );
    }

    res.json({ message: "Student registered with 3 images (same person, single-face validated)", student_id: sId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});


// List Students
app.get("/students", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM ai_students ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Class Attendance (multiple images, student_ids array)
app.post("/class/attendance", upload.array("images", 5), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { timetable_id, student_ids } = req.body;
    if (!timetable_id || !student_ids) return res.status(400).json({ error: "timetable_id and student_ids required" });
    const studentIds = JSON.parse(student_ids);
    if (!Array.isArray(studentIds) || studentIds.length === 0) return res.status(400).json({ error: "student_ids must be a non-empty array" });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "At least one class image required" });

    // Fetch students with images
    const [students] = await conn.query(
      `SELECT s.id AS student_id, s.name, i.face_descriptor
       FROM ai_students s
       JOIN ai_student_images i ON s.id = i.student_id
       WHERE s.id IN (?)`,
      [studentIds]
    );

    if (students.length === 0) return res.status(400).json({ error: "No student images found for given IDs" });

    const labeledDescriptorsMap = {};
    students.forEach(s => {
      try {
        const arr = JSON.parse(s.face_descriptor);
        const f32 = new Float32Array(arr);
        if (!labeledDescriptorsMap[s.student_id]) labeledDescriptorsMap[s.student_id] = [];
        labeledDescriptorsMap[s.student_id].push(f32);
      } catch {}
    });

    const labeledDescriptors = Object.entries(labeledDescriptorsMap).map(
      ([id, descriptors]) => new faceapi.LabeledFaceDescriptors(id, descriptors)
    );

    if (labeledDescriptors.length === 0) return res.status(400).json({ error: "No valid descriptors found" });

    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, FACE_MATCHER_THRESHOLD);

    // Process all class images
    const presentSet = new Set();
    for (const file of req.files) {
      const classImg = await loadImage(file.path);
      const detections = await faceapi.detectAllFaces(classImg).withFaceLandmarks().withFaceDescriptors();
      detections.forEach(d => {
        const bestMatch = faceMatcher.findBestMatch(d.descriptor);
        if (bestMatch.label !== "unknown") presentSet.add(Number(bestMatch.label));
      });
    }

    const uniquePresent = [...presentSet];
    const absentStudentIds = studentIds.filter(id => !uniquePresent.includes(id));

    // Upsert Present
    if (uniquePresent.length) {
      const placeholders = uniquePresent.map(() => "(?, ?, 'Present')").join(",");
      const params = uniquePresent.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE status='Present'`,
        params
      );
    }

    // Upsert Absent
    if (absentStudentIds.length) {
      const placeholders = absentStudentIds.map(() => "(?, ?, 'Absent')").join(",");
      const params = absentStudentIds.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE status='Absent'`,
        params
      );
    }

    res.json({
      message: "Attendance processed",
      presentCount: uniquePresent.length,
      absentCount: absentStudentIds.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Get Attendance by timetable
app.get("/attendance", async (req, res) => {
  try {
    const { timetable_id } = req.query;
    if (!timetable_id) return res.status(400).json({ error: "timetable_id required" });

    const [rows] = await pool.query(
      `SELECT a.id, a.status, s.id AS student_id, s.name,s.student_id,s.app_id
       FROM ai_attendance a
       JOIN ai_students s ON s.id = a.student_id
       WHERE a.timetable_id = ?
       ORDER BY s.name`,
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
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Add student: POST /students (student_id, app_id, name, images[3])`);
      console.log(`Class attendance: POST /class/attendance (timetable_id, student_ids, images[1+])`);
      console.log(`Get attendance: GET /attendance?timetable_id=ID`);
    });
  } catch (err) {
    console.error("Fatal init error:", err);
    process.exit(1);
  }
})();
