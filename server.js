require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// Determine DB config
const dbConfig = {
  host: process.env.MYSQLHOST || process.env.LOCAL_DB_HOST,
  user: process.env.MYSQLUSER || process.env.LOCAL_DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.LOCAL_DB_PASS,
  database: process.env.MYSQLDATABASE || process.env.LOCAL_DB_NAME,
  port: process.env.MYSQLPORT || process.env.LOCAL_DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Test DB connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ DB connected successfully!');
    connection.release();
  } catch (err) {
    console.error('❌ DB connection failed:', err);
  }
})();

// Initialize tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(50)
      )
    `);
    console.log('✅ Students table ready!');
  } catch (err) {
    console.error('❌ DB initialization error:', err);
  }
}

initDB();

// Example route
app.get('/students', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM students');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
