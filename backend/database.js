const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'profsolar.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) { console.error('❌ DB error:', err.message); }
    else { console.log('✅ Connected to SQLite.'); initializeTables(); }
});

function initializeTables() {
    db.serialize(() => {
        // One-time scheduled/published posts
        db.run(`CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            media_paths TEXT,
            scheduled_time DATETIME,   -- stored as UTC ISO string
            status TEXT DEFAULT 'draft',
            post_type TEXT DEFAULT 'feed',
            fb_post_id TEXT,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            published_at DATETIME
        )`);

        // Recurring weekly schedule slots (day + time in SAST = UTC+2)
        db.run(`CREATE TABLE IF NOT EXISTS recurring_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_of_week INTEGER NOT NULL,  -- 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
            post_time TEXT NOT NULL,       -- HH:MM in SAST (Africa/Johannesburg)
            content TEXT NOT NULL,
            post_type TEXT DEFAULT 'feed',
            is_active INTEGER DEFAULT 1,
            last_fired_date TEXT,          -- YYYY-MM-DD in SAST, prevents double-firing
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Daily follower snapshots for growth chart
        db.run(`CREATE TABLE IF NOT EXISTS follower_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fan_count INTEGER NOT NULL,
            followers_count INTEGER,
            recorded_at DATE DEFAULT (date('now')) UNIQUE
        )`);

        // Cached FB post engagement data
        db.run(`CREATE TABLE IF NOT EXISTS post_engagement_cache (
            fb_post_id TEXT PRIMARY KEY,
            message TEXT,
            created_time TEXT,
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            shares INTEGER DEFAULT 0,
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });
    console.log('✅ All tables ready.');
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
    });
}

module.exports = { db, dbRun, dbAll, dbGet };
