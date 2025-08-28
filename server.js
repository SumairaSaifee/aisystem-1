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
  // Resize image to speed up processing
  const buffer = await sharp(filePath).resize(512).toBuffer();
  const img = await loadImage(buffer);
  const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
  if (!detection) throw new Error(`No face detected in ${filePath}`);
  return detection.descriptor;
}

/* -------------------- App -------------------- */
const app = express();
app.use(morgan("dev"));
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_ROOT));

/* -------------------- Routes -------------------- */

// Add Student (files or URLs)
app.post("/students", upload.array("images", 3), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { student_id, app_id, name, image_urls } = req.body;
    if (!student_id || !app_id || !name)
      return res.status(400).json({ error: "student_id, app_id, and name are required" });

    let filePaths = req.files?.map(f => f.path) || [];

    if (image_urls) {
      let urls = [];
      try { urls = JSON.parse(image_urls); } 
      catch { urls = Array.isArray(image_urls) ? image_urls : [image_urls]; }
      const downloaded = await Promise.all(urls.map(url => downloadImage(url, UP_STUDENTS, student_id)));
      filePaths.push(...downloaded);
    }

    if (filePaths.length !== 3)
      return res.status(400).json({ error: "Exactly 3 images are required" });

    // Duplicate check
    const [existing] = await conn.execute(
      "SELECT id FROM ai_students WHERE student_id = ? OR app_id = ?",
      [student_id, app_id]
    );
    if (existing.length > 0)
      return res.status(400).json({ error: "Duplicate student_id or app_id" });

    // Compute descriptors in parallel
    const descriptors = await Promise.all(filePaths.map(fp => processImage(fp)));

    // Validate same person
    const base = descriptors[0];
    if (descriptors.some(d => faceapi.euclideanDistance(base, d) > 0.6))
      return res.status(400).json({ error: "Images are not of the same person" });

    // Insert student
    const [result] = await conn.execute(
      "INSERT INTO ai_students (student_id, app_id, name) VALUES (?, ?, ?)",
      [student_id, app_id, name]
    );
    const sId = result.insertId;

    // Batch insert images + descriptors
    const values = filePaths.map((fp, i) => [
      sId,
      path.relative(__dirname, fp).replace(/\\/g, "/"),
      JSON.stringify(Array.from(descriptors[i]))
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

// Class Attendance (file upload)
app.post("/class/attendance", upload.array("images", 5), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { timetable_id, student_ids } = req.body;
    if (!timetable_id || !student_ids || !req.files?.length)
      return res.status(400).json({ error: "timetable_id, student_ids, and images required" });

    const studentIds = Array.isArray(student_ids) ? student_ids : JSON.parse(student_ids);

    const [students] = await conn.query(
      `SELECT s.id AS student_id, i.face_descriptor
       FROM ai_students s
       JOIN ai_student_images i ON s.id = i.student_id
       WHERE s.student_id IN (?)`,
      [studentIds]
    );

    if (!students.length) return res.status(400).json({ error: "No student images found" });

    const labeledDescriptors = Object.entries(students.reduce((acc, s) => {
      const arr = JSON.parse(s.face_descriptor);
      const f32 = new Float32Array(arr);
      if (!acc[s.student_id]) acc[s.student_id] = [];
      acc[s.student_id].push(f32);
      return acc;
    }, {})).map(([id, descs]) => new faceapi.LabeledFaceDescriptors(id, descs));

    const matcher = new faceapi.FaceMatcher(labeledDescriptors, FACE_MATCHER_THRESHOLD);

    const presentSet = new Set();
    await Promise.all(req.files.map(async file => {
      const img = await loadImage(file.path);
      const detections = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
      detections.forEach(d => {
        const match = matcher.findBestMatch(d.descriptor);
        if (match.label !== "unknown") presentSet.add(Number(match.label));
      });
    }));

    const uniquePresent = [...presentSet];
    const absentIds = studentIds.filter(id => !uniquePresent.includes(id));

    // Batch upsert present
    if (uniquePresent.length) {
      const placeholders = uniquePresent.map(() => "(?, ?, 'Present')").join(",");
      const params = uniquePresent.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status) VALUES ${placeholders} ON DUPLICATE KEY UPDATE status='Present'`,
        params
      );
    }

    // Batch upsert absent
    if (absentIds.length) {
      const placeholders = absentIds.map(() => "(?, ?, 'Absent')").join(",");
      const params = absentIds.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status) VALUES ${placeholders} ON DUPLICATE KEY UPDATE status='Absent'`,
        params
      );
    }

    res.json({ message: "Attendance processed", presentCount: uniquePresent.length, absentCount: absentIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Class Attendance (image URLs)
app.post("/class/attendance-url", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { timetable_id, student_ids, image_urls } = req.body;
    if (!timetable_id || !student_ids || !image_urls)
      return res.status(400).json({ error: "timetable_id, student_ids, image_urls required" });

    const studentIds = Array.isArray(student_ids) ? student_ids : JSON.parse(student_ids);
    const urls = Array.isArray(image_urls) ? image_urls : JSON.parse(image_urls);

    const filePaths = await Promise.all(urls.map(url => downloadImage(url, UP_CLASSES)));

    const [students] = await conn.query(
      `SELECT s.student_id AS student_id, i.face_descriptor
       FROM ai_students s
       JOIN ai_student_images i ON s.id = i.student_id
       WHERE s.student_id IN (?)`,
      [studentIds]
    );

    const labeledDescriptors = Object.entries(students.reduce((acc, s) => {
      const arr = JSON.parse(s.face_descriptor);
      const f32 = new Float32Array(arr);
      if (!acc[s.student_id]) acc[s.student_id] = [];
      acc[s.student_id].push(f32);
      return acc;
    }, {})).map(([id, descs]) => new faceapi.LabeledFaceDescriptors(id, descs));

    const matcher = new faceapi.FaceMatcher(labeledDescriptors, FACE_MATCHER_THRESHOLD);

    const presentSet = new Set();
    await Promise.all(filePaths.map(async fp => {
      const img = await loadImage(fp);
      const detections = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
      detections.forEach(d => {
        const match = matcher.findBestMatch(d.descriptor);
        if (match.label !== "unknown") presentSet.add(Number(match.label));
      });
    }));

    const uniquePresent = [...presentSet];
    const absentIds = studentIds.filter(id => !uniquePresent.includes(id));

    if (uniquePresent.length) {
      const placeholders = uniquePresent.map(() => "(?, ?, 'Present')").join(",");
      const params = uniquePresent.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status) VALUES ${placeholders} ON DUPLICATE KEY UPDATE status='Present'`,
        params
      );
    }
    if (absentIds.length) {
      const placeholders = absentIds.map(() => "(?, ?, 'Absent')").join(",");
      const params = absentIds.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status) VALUES ${placeholders} ON DUPLICATE KEY UPDATE status='Absent'`,
        params
      );
    }

    res.json({ message: "Attendance processed via URLs", presentCount: uniquePresent.length, absentCount: absentIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});


app.post("/api/attendance-by-url", async (req, res) => {
  try {
    const { timetable_id, student_ids, image_urls } = req.body;
    if (!timetable_id || !student_ids || !image_urls)
      return res.status(400).json({ error: "timetable_id, student_ids, image_urls required" });

    const studentIds = Array.isArray(student_ids) ? student_ids : JSON.parse(student_ids);
    const urls = Array.isArray(image_urls) ? image_urls : JSON.parse(image_urls);

    // ✅ Respond immediately (avoid 499 timeout)
    res.json({
      message: "Attendance request received. Processing in background.",
      timetable_id,
      studentCount: studentIds.length,
      imageCount: urls.length
    });

    // 🔄 Run heavy work in background
    processAttendanceAsync(timetable_id, studentIds, urls);

  } catch (err) {
    console.error("Request error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ==============================
// Background Worker Function
// ==============================
async function processAttendanceAsync(timetable_id, studentIds, urls) {
  const conn = await pool.getConnection();
  try {
    console.log(`[Attendance] Start timetable ${timetable_id}...`);

    // Step 1: download all images
    const filePaths = await Promise.all(urls.map(url => downloadImage(url, UP_CLASSES)));

    // Step 2: fetch students + face descriptors
    const [students] = await conn.query(
      `SELECT s.student_id AS student_id, i.face_descriptor
       FROM ai_students s
       JOIN ai_student_images i ON s.id = i.student_id
       WHERE s.student_id IN (?)`,
      [studentIds]
    );

    const labeledDescriptors = Object.entries(
      students.reduce((acc, s) => {
        try {
          const arr = JSON.parse(s.face_descriptor);
          const f32 = new Float32Array(arr);
          if (!acc[s.student_id]) acc[s.student_id] = [];
          acc[s.student_id].push(f32);
        } catch (e) {
          console.warn(`Invalid descriptor for student ${s.student_id}`);
        }
        return acc;
      }, {})
    ).map(([id, descs]) => new faceapi.LabeledFaceDescriptors(id, descs));

    if (!labeledDescriptors.length) {
      console.error("[Attendance] No valid student face descriptors found");
      return;
    }

    const matcher = new faceapi.FaceMatcher(labeledDescriptors, FACE_MATCHER_THRESHOLD);

    // Step 3: detect faces
    const presentSet = new Set();
    let totalDetections = 0;

    await Promise.all(filePaths.map(async fp => {
      try {
        const img = await loadImage(fp);
        const detections = await faceapi
          .detectAllFaces(img)
          .withFaceLandmarks()
          .withFaceDescriptors();

        totalDetections += detections.length;

        detections.forEach(d => {
          const match = matcher.findBestMatch(d.descriptor);
          if (match.label !== "unknown") {
            presentSet.add(Number(match.label));
          }
        });
      } catch (e) {
        console.error("[Attendance] Image load/detect failed:", e.message);
      }
    }));

    const uniquePresent = [...presentSet];
    const absentIds = studentIds.filter(id => !uniquePresent.includes(id));

    // Step 4: Mark all students as Absent
    if (studentIds.length) {
      const placeholders = studentIds.map(() => "(?, ?, 'Absent')").join(",");
      const params = studentIds.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE status='Absent'`,
        params
      );
    }

    // Step 5: Update detected faces to Present
    if (uniquePresent.length) {
      const placeholders = uniquePresent.map(() => "(?, ?, 'Present')").join(",");
      const params = uniquePresent.flatMap(id => [id, timetable_id]);
      await conn.execute(
        `INSERT INTO ai_attendance (student_id, timetable_id, status) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE status='Present'`,
        params
      );
    }

    console.log(
      `[Attendance] Done timetable ${timetable_id}: Present=${uniquePresent.length}, Absent=${absentIds.length}, Detections=${totalDetections}`
    );

  } catch (err) {
    console.error("[Attendance] Processing error:", err);
  } finally {
    conn.release();
  }
}

// Get attendance
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
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Add student: POST /students`);
      console.log(`Class attendance: POST /class/attendance`);
      console.log(`Class attendance via URLs: POST /class/attendance-url`);
      console.log(`Get attendance: GET /attendance?timetable_id=ID`);
    });
  } catch (err) {
    console.error("Fatal init error:", err);
    process.exit(1);
  }
})();
