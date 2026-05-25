require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cron    = require('node-cron');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { dbRun, dbAll, dbGet } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const FB_API       = 'https://graph.facebook.com/v19.0';
const PAGE_ID      = process.env.FB_PAGE_ID;
const ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

if (!PAGE_ID || !ACCESS_TOKEN) {
    console.error('❌ FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing in .env!');
    process.exit(1);
}

// ── SAST helper (UTC+2, no DST) ──────────────────────────────────────────────
function nowSAST() {
    const utc = new Date();
    return new Date(utc.getTime() + 2 * 60 * 60 * 1000); // +2h
}
function todaySAST() { return nowSAST().toISOString().slice(0, 10); }

// ── Facebook publisher ────────────────────────────────────────────────────────
async function publishToFacebook(post) {
    try {
        let mediaIds = [];
        if (post.media && post.media.length > 0) {
            for (const filePath of post.media) {
                const ext     = path.extname(filePath).toLowerCase();
                const isVideo = ['.mp4', '.mov', '.avi'].includes(ext);
                const FormData = require('form-data');
                const fd = new FormData();
                fd.append('access_token', ACCESS_TOKEN);
                fd.append('source', fs.createReadStream(filePath));
                fd.append('published', 'false');
                const url = isVideo ? `${FB_API}/${PAGE_ID}/videos` : `${FB_API}/${PAGE_ID}/photos`;
                const r   = await axios.post(url, fd, { headers: fd.getHeaders() });
                mediaIds.push(r.data.id);
            }
        }
        const payload = { message: post.content, access_token: ACCESS_TOKEN, published: true };
        if (mediaIds.length) payload.attached_media = mediaIds.map(id => ({ media_fbid: id }));
        const r = await axios.post(`${FB_API}/${PAGE_ID}/feed`, payload);
        console.log(`✅ Published to Facebook! ID: ${r.data.id}`);
        if (post.id) {
            await dbRun(
                `UPDATE posts SET status='published', fb_post_id=?, published_at=CURRENT_TIMESTAMP WHERE id=?`,
                [r.data.id, post.id]
            );
        }
        return r.data.id;
    } catch (error) {
        const msg = error.response?.data?.error?.message || error.message;
        console.error(`❌ Publish failed: ${msg}`);
        if (post.id) await dbRun(`UPDATE posts SET status='failed', error_message=? WHERE id=?`, [msg, post.id]);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONE-TIME SCHEDULED POSTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/posts', async (req, res) => {
    try {
        const posts = await dbAll('SELECT * FROM posts ORDER BY created_at DESC');
        res.json({ success: true, posts });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/posts', upload.array('media', 5), async (req, res) => {
    try {
        const { content, scheduledTime, postType } = req.body;
        // scheduledTime arrives as UTC ISO string from the frontend
        const media  = req.files ? req.files.map(f => f.path) : [];
        const status = scheduledTime ? 'scheduled' : 'published';
        const result = await dbRun(
            `INSERT INTO posts (content, media_paths, scheduled_time, status, post_type)
             VALUES (?, ?, ?, ?, ?)`,
            [content, JSON.stringify(media), scheduledTime || null, status, postType || 'feed']
        );
        const newPost = { id: result.id, content, media, scheduledTime, status, postType: postType || 'feed' };
        if (status === 'published') publishToFacebook(newPost);
        res.json({ success: true, post: newPost });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/posts/:id', async (req, res) => {
    try {
        await dbRun('DELETE FROM posts WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── One-time scheduler: runs every minute, compares in UTC ───────────────────
cron.schedule('* * * * *', async () => {
    try {
        const nowUtc = new Date().toISOString(); // e.g. "2026-05-25T12:30:00.000Z"
        // scheduled_time is stored as UTC ISO ("2026-05-25T12:30:00.000Z")
        const due = await dbAll(
            `SELECT * FROM posts WHERE status='scheduled' AND scheduled_time <= ?`,
            [nowUtc]
        );
        for (const post of due) {
            console.log(`⏰ Firing scheduled post id=${post.id}`);
            post.media = post.media_paths ? JSON.parse(post.media_paths) : [];
            await publishToFacebook(post);
        }
    } catch (e) { console.error('Scheduler error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECURRING WEEKLY SCHEDULES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/recurring-schedules', async (req, res) => {
    try {
        const rows = await dbAll('SELECT * FROM recurring_schedules ORDER BY day_of_week, post_time');
        res.json({ success: true, schedules: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/recurring-schedules', async (req, res) => {
    try {
        const { day_of_week, post_time, content, post_type } = req.body;
        if (day_of_week === undefined || !post_time || !content) {
            return res.status(400).json({ success: false, error: 'day_of_week, post_time, and content are required.' });
        }
        const result = await dbRun(
            `INSERT INTO recurring_schedules (day_of_week, post_time, content, post_type) VALUES (?, ?, ?, ?)`,
            [day_of_week, post_time, content, post_type || 'feed']
        );
        const row = await dbGet('SELECT * FROM recurring_schedules WHERE id = ?', [result.id]);
        res.json({ success: true, schedule: row });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/recurring-schedules/:id/toggle', async (req, res) => {
    try {
        await dbRun(
            `UPDATE recurring_schedules SET is_active = CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE id=?`,
            [req.params.id]
        );
        const row = await dbGet('SELECT * FROM recurring_schedules WHERE id = ?', [req.params.id]);
        res.json({ success: true, schedule: row });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/recurring-schedules/:id', async (req, res) => {
    try {
        await dbRun('DELETE FROM recurring_schedules WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Recurring cron: every minute, check SAST day+time ────────────────────────
cron.schedule('* * * * *', async () => {
    try {
        const sast    = nowSAST();
        const dow     = sast.getDay();  // 0-6
        const hh      = String(sast.getHours()).padStart(2, '0');
        const mm      = String(sast.getMinutes()).padStart(2, '0');
        const timeNow = `${hh}:${mm}`;  // e.g. "08:00"
        const today   = todaySAST();    // e.g. "2026-05-25"

        const due = await dbAll(
            `SELECT * FROM recurring_schedules
             WHERE is_active=1
               AND day_of_week=?
               AND post_time=?
               AND (last_fired_date IS NULL OR last_fired_date != ?)`,
            [dow, timeNow, today]
        );

        for (const sched of due) {
            console.log(`🔁 Firing recurring schedule id=${sched.id} (day ${dow} ${timeNow})`);
            const fbId = await publishToFacebook({ content: sched.content, post_type: sched.post_type, media: [] });
            if (fbId) {
                // Record the fire so we don't double-post today
                await dbRun(`UPDATE recurring_schedules SET last_fired_date=? WHERE id=?`, [today, sched.id]);
                // Also save a record in posts table for history
                await dbRun(
                    `INSERT INTO posts (content, status, post_type, fb_post_id, published_at)
                     VALUES (?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
                    [sched.content, sched.post_type, fbId]
                );
            }
        }
    } catch (e) { console.error('Recurring scheduler error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

let analyticsCache = { data: null, timestamp: 0 };
const CACHE_DURATION = 10 * 60 * 1000;

async function snapshotFollowers() {
    try {
        const r = await axios.get(`${FB_API}/${PAGE_ID}`, {
            params: { fields: 'fan_count,followers_count,name', access_token: ACCESS_TOKEN }
        });
        await dbRun(
            `INSERT OR REPLACE INTO follower_snapshots (fan_count, followers_count, recorded_at)
             VALUES (?, ?, date('now'))`,
            [r.data.fan_count, r.data.followers_count || r.data.fan_count]
        );
        return r.data;
    } catch (e) { console.log('⚠️ Snapshot failed:', e.response?.data?.error?.message || e.message); return null; }
}

async function fetchAndCachePosts() {
    try {
        const r = await axios.get(`${FB_API}/${PAGE_ID}/posts`, {
            params: {
                fields: 'id,message,created_time,likes.summary(true),comments.summary(true),shares',
                limit: 50, access_token: ACCESS_TOKEN
            }
        });
        for (const p of r.data.data || []) {
            await dbRun(
                `INSERT OR REPLACE INTO post_engagement_cache
                 (fb_post_id, message, created_time, likes, comments, shares, fetched_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [p.id, p.message || '', p.created_time,
                 p.likes?.summary?.total_count || 0,
                 p.comments?.summary?.total_count || 0,
                 p.shares?.count || 0]
            );
        }
        return r.data.data.length;
    } catch (e) { console.log('⚠️ Post cache failed:', e.response?.data?.error?.message || e.message); return 0; }
}

app.get('/api/analytics', async (req, res) => {
    if (analyticsCache.data && Date.now() - analyticsCache.timestamp < CACHE_DURATION) {
        return res.json(analyticsCache.data);
    }
    try {
        const pageData  = await snapshotFollowers();
        await fetchAndCachePosts();
        const snapshots = await dbAll(`SELECT recorded_at, fan_count FROM follower_snapshots ORDER BY recorded_at ASC LIMIT 30`);
        const allPosts  = await dbAll(`SELECT * FROM post_engagement_cache ORDER BY created_time DESC LIMIT 50`);
        const now       = new Date();
        const thisMonth = allPosts.filter(p => { const d = new Date(p.created_time); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
        const last30    = allPosts.filter(p => (now - new Date(p.created_time)) <= 30 * 86400000);
        const totalLikes    = last30.reduce((a, p) => a + p.likes, 0);
        const totalComments = last30.reduce((a, p) => a + p.comments, 0);
        const totalShares   = last30.reduce((a, p) => a + p.shares, 0);
        const totalEng      = totalLikes + totalComments + totalShares;
        const fans          = pageData?.fan_count || (snapshots[snapshots.length - 1]?.fan_count || 0);
        const engRate       = last30.length > 0 && fans > 0 ? ((totalEng / (last30.length * fans)) * 100).toFixed(2) : '0.00';
        const oldest = snapshots[0]; const newest = snapshots[snapshots.length - 1];
        const followerGain = oldest && newest ? newest.fan_count - oldest.fan_count : 0;
        const dailyMap = {};
        for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); dailyMap[d.toISOString().slice(0, 10)] = { likes: 0, comments: 0, shares: 0 }; }
        for (const p of last30) { const k = p.created_time.slice(0, 10); if (dailyMap[k]) { dailyMap[k].likes += p.likes; dailyMap[k].comments += p.comments; dailyMap[k].shares += p.shares; } }
        const days = Object.keys(dailyMap).sort();
        const fmt = d => { const dt = new Date(d); return dt.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' }); };
        const result = {
            success: true, pageName: pageData?.name || 'Prof Solar',
            stats: { fans, postsThisMonth: thisMonth.length, totalLikes, totalComments, totalShares, totalEngagement: totalEng, engagementRate: engRate, followerGain, avgLikesPerPost: last30.length ? Math.round(totalLikes / last30.length) : 0, avgCommentsPerPost: last30.length ? Math.round(totalComments / last30.length) : 0 },
            series: { labels: days.map(fmt), likes: days.map(d => dailyMap[d].likes), comments: days.map(d => dailyMap[d].comments), shares: days.map(d => dailyMap[d].shares) },
            growth: { labels: snapshots.map(s => fmt(s.recorded_at)), fans: snapshots.map(s => s.fan_count), note: snapshots.length < 2 ? 'Growth chart builds as daily snapshots accumulate.' : null },
            lastUpdated: new Date().toLocaleTimeString('en-ZA')
        };
        analyticsCache = { data: result, timestamp: Date.now() };
        res.json(result);
    } catch (e) {
        console.error('Analytics error:', e.response?.data || e.message);
        res.json(analyticsCache.data || { success: false, error: e.message, stats: {}, series: { labels: [], likes: [], comments: [], shares: [] }, growth: { labels: [], fans: [] }, lastUpdated: 'Error' });
    }
});

app.get('/api/analytics/posts', async (req, res) => {
    try {
        const posts = await dbAll(`SELECT *, (likes+comments+shares) as total_engagement FROM post_engagement_cache ORDER BY total_engagement DESC LIMIT 10`);
        res.json({ success: true, posts });
    } catch (e) { res.status(500).json({ success: false, posts: [], error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

cron.schedule('0 0 * * *', snapshotFollowers);
cron.schedule('0 * * * *', fetchAndCachePosts);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Prof Solar server on http://localhost:${PORT}`);
    await snapshotFollowers();
    await fetchAndCachePosts();
    console.log('✅ Startup data fetch complete.');
});
