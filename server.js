const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// Railway MySQL config (injected automatically)
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,       // Railway internal host
  user: process.env.MYSQLUSER,       // Railway DB user
  password: process.env.MYSQLPASSWORD, // Railway DB password
  database: process.env.MYSQLDATABASE, // Railway DB name
  port: process.env.MYSQLPORT,       // Railway DB port
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ DB connected successfully on Railway!');
    connection.release();
  } catch (err) {
    console.error('❌ DB connection failed:', err);
  }
})();

// Initialize students table
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

// Sample route
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
