const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database file named profsolar.db in the backend folder
const DB_PATH = path.join(__dirname, 'profsolar.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Connected to SQLite database.');
        initializeTables();
    }
});

// Create the posts table if it doesn't exist
function initializeTables() {
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        media_paths TEXT,
        scheduled_time DATETIME,
        status TEXT DEFAULT 'draft',
        post_type TEXT DEFAULT 'feed',
        fb_post_id TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME
    )`, (err) => {
        if (err) console.error('❌ Table creation error:', err.message);
        else console.log('✅ Posts table ready.');
    });
}

// Helper: Promisify db.run
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

// Helper: Promisify db.all
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper: Promisify db.get
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

module.exports = { db, dbRun, dbAll, dbGet };
