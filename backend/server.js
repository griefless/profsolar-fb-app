require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { dbRun, dbAll, dbGet } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const FB_API = 'https://graph.facebook.com/v19.0';
const PAGE_ID = process.env.FB_PAGE_ID;
const ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

if (!PAGE_ID || !ACCESS_TOKEN) {
    console.error('❌ ERROR: FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing in .env file!');
    process.exit(1);
}

// ==================== POSTS API ====================

app.get('/api/posts', async (req, res) => {
    try {
        const posts = await dbAll('SELECT * FROM posts ORDER BY created_at DESC');
        res.json({ success: true, posts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/posts', upload.array('media', 5), async (req, res) => {
    try {
        const { content, scheduledTime, postType } = req.body;
        const mediaFiles = req.files ? req.files.map(f => f.path) : [];
        const mediaPathsJson = JSON.stringify(mediaFiles);
        const status = scheduledTime ? 'scheduled' : 'published';

        const result = await dbRun(
            `INSERT INTO posts (content, media_paths, scheduled_time, status, post_type) VALUES (?, ?, ?, ?, ?)`,
            [content, mediaPathsJson, scheduledTime || null, status, postType || 'feed']
        );

        const newPost = { id: result.id, content, media: mediaFiles, scheduledTime: scheduledTime || null, status, postType: postType || 'feed' };
        if (status === 'published') publishToFacebook(newPost);
        res.json({ success: true, post: newPost });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/posts/:id', async (req, res) => {
    try {
        await dbRun('DELETE FROM posts WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== FACEBOOK PUBLISHING ====================

async function publishToFacebook(post) {
    try {
        let mediaIds = [];
        if (post.media && post.media.length > 0) {
            for (const filePath of post.media) {
                const ext = path.extname(filePath).toLowerCase();
                const isVideo = ['.mp4', '.mov', '.avi'].includes(ext);
                const FormData = require('form-data');
                const formData = new FormData();
                formData.append('access_token', ACCESS_TOKEN);
                formData.append('source', fs.createReadStream(filePath));
                formData.append('published', 'false');
                const uploadUrl = isVideo ? `${FB_API}/${PAGE_ID}/videos` : `${FB_API}/${PAGE_ID}/photos`;
                const uploadRes = await axios.post(uploadUrl, formData, { headers: formData.getHeaders() });
                mediaIds.push(uploadRes.data.id);
            }
        }
        const postData = { message: post.content, access_token: ACCESS_TOKEN, published: true };
        if (mediaIds.length > 0) postData.attached_media = mediaIds.map(id => ({ media_fbid: id }));
        const publishRes = await axios.post(`${FB_API}/${PAGE_ID}/feed`, postData);
        console.log(`✅ Published! FB ID: ${publishRes.data.id}`);
        await dbRun(`UPDATE posts SET status='published', fb_post_id=?, published_at=CURRENT_TIMESTAMP WHERE id=?`, [publishRes.data.id, post.id]);
    } catch (error) {
        const msg = error.response?.data?.error?.message || error.message;
        console.error(`❌ Publish failed:`, msg);
        await dbRun(`UPDATE posts SET status='failed', error_message=? WHERE id=?`, [msg, post.id]);
    }
}

cron.schedule('* * * * *', async () => {
    try {
        const now = new Date().toISOString();
        const duePosts = await dbAll(`SELECT * FROM posts WHERE status='scheduled' AND scheduled_time<=?`, [now]);
        for (const post of duePosts) {
            post.media = post.media_paths ? JSON.parse(post.media_paths) : [];
            await publishToFacebook(post);
        }
    } catch (error) {
        console.error('❌ Scheduler error:', error.message);
    }
});

// ==================== ANALYTICS ====================

let analyticsCache = { data: null, timestamp: 0 };
const CACHE_DURATION = 5 * 60 * 1000;

function buildDateLabels(n) {
    return Array.from({ length: n }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (n - 1 - i));
        return d.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' });
    });
}

function extractSeries(metrics, name, days = 30) {
    const m = metrics.find(x => x.name === name);
    if (!m || !m.values) return Array(days).fill(0);
    const vals = m.values.slice(-days).map(v => (typeof v.value === 'object' ? Object.values(v.value).reduce((a, b) => a + b, 0) : v.value || 0));
    while (vals.length < days) vals.unshift(0);
    return vals;
}

app.get('/api/analytics', async (req, res) => {
    if (analyticsCache.data && Date.now() - analyticsCache.timestamp < CACHE_DURATION) {
        return res.json(analyticsCache.data);
    }
    try {
        const since = Math.floor((Date.now() - 31 * 24 * 3600 * 1000) / 1000);
        const until = Math.floor(Date.now() / 1000);

        // 1. Page summary
        const pageRes = await axios.get(`${FB_API}/${PAGE_ID}`, {
            params: { fields: 'fan_count,followers_count,name', access_token: ACCESS_TOKEN }
        });
        const { fan_count: followers, name: pageName } = pageRes.data;
        console.log(`✅ Page: ${pageName} | Followers: ${followers}`);

        // 2. Daily insights — using only stable, non-deprecated metrics
        let metrics = [];
        try {
            const insightsRes = await axios.get(`${FB_API}/${PAGE_ID}/insights`, {
                params: {
                    metric: [
                        'page_impressions_unique',
                        'page_impressions',
                        'page_engaged_users',
                        'page_fan_adds',
                        'page_fan_removes',
                        'page_video_views'
                    ].join(','),
                    period: 'day',
                    since,
                    until,
                    access_token: ACCESS_TOKEN
                }
            });
            metrics = insightsRes.data.data;
            console.log(`✅ Insights loaded: ${metrics.length} metrics`);
        } catch (insightErr) {
            console.warn('⚠️ Insights fetch failed:', insightErr.response?.data?.error?.message || insightErr.message);
        }

        const reachSeries      = extractSeries(metrics, 'page_impressions_unique', 30);
        const impressionSeries = extractSeries(metrics, 'page_impressions', 30);
        const engagedSeries    = extractSeries(metrics, 'page_engaged_users', 30);
        const fanAddsSeries    = extractSeries(metrics, 'page_fan_adds', 30);
        const fanRemovesSeries = extractSeries(metrics, 'page_fan_removes', 30);
        const videoViewSeries  = extractSeries(metrics, 'page_video_views', 30);

        const totalReach       = reachSeries.reduce((a, v) => a + v, 0);
        const totalImpressions = impressionSeries.reduce((a, v) => a + v, 0);
        const totalEngaged     = engagedSeries.reduce((a, v) => a + v, 0);
        const totalVideoViews  = videoViewSeries.reduce((a, v) => a + v, 0);
        const netFanAdds       = fanAddsSeries.reduce((a, v) => a + v, 0) - fanRemovesSeries.reduce((a, v) => a + v, 0);

        let runningFollowers = Math.max(0, followers - fanAddsSeries.reduce((a, v) => a + v, 0) + fanRemovesSeries.reduce((a, v) => a + v, 0));
        const followerSeries = fanAddsSeries.map((add, i) => {
            runningFollowers += add - (fanRemovesSeries[i] || 0);
            return runningFollowers;
        });

        const engagementRate = totalReach > 0 ? ((totalEngaged / totalReach) * 100).toFixed(1) : '0.0';

        // 3. Posts this month
        let postsThisMonth = 0;
        try {
            const postsRes = await axios.get(`${FB_API}/${PAGE_ID}/posts`, {
                params: { fields: 'created_time', limit: 100, access_token: ACCESS_TOKEN }
            });
            const now = new Date();
            postsThisMonth = postsRes.data.data.filter(p => {
                const d = new Date(p.created_time);
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
            }).length;
            console.log(`✅ Posts this month: ${postsThisMonth}`);
        } catch (e) {
            console.log('⚠️ Posts count failed:', e.message);
        }

        // 4. Week-over-week reach change
        const prevReach   = reachSeries.slice(0, 14).reduce((a, v) => a + v, 0);
        const currReach   = reachSeries.slice(14).reduce((a, v) => a + v, 0);
        const reachChange = prevReach > 0 ? (((currReach - prevReach) / prevReach) * 100).toFixed(1) : '0.0';

        const labels30d = buildDateLabels(30);

        const result = {
            success: true,
            pageName,
            stats: {
                followers,
                reach: totalReach,
                impressions: totalImpressions,
                engagementRate,
                engagedUsers: totalEngaged,
                postsThisMonth,
                videoViews: totalVideoViews,
                netFanAdds,
                reachChange
            },
            series: {
                labels: labels30d,
                reach: reachSeries,
                impressions: impressionSeries,
                engaged: engagedSeries,
                fanAdds: fanAddsSeries,
                followers: followerSeries
            },
            lastUpdated: new Date().toLocaleTimeString('en-ZA')
        };

        analyticsCache = { data: result, timestamp: Date.now() };
        res.json(result);

    } catch (error) {
        console.error('⚠️ Analytics error:', error.response?.data || error.message);
        res.json(analyticsCache.data || {
            success: false,
            error: error.response?.data?.error?.message || error.message,
            stats: { followers: 0, reach: 0, impressions: 0, engagementRate: '0.0', engagedUsers: 0, postsThisMonth: 0, videoViews: 0, netFanAdds: 0, reachChange: '0.0' },
            series: { labels: buildDateLabels(30), reach: Array(30).fill(0), impressions: Array(30).fill(0), engaged: Array(30).fill(0), fanAdds: Array(30).fill(0), followers: Array(30).fill(0) },
            lastUpdated: 'API Error'
        });
    }
});

// ==================== TOP POSTS ====================

let postsCache = { data: null, timestamp: 0 };

app.get('/api/analytics/posts', async (req, res) => {
    if (postsCache.data && Date.now() - postsCache.timestamp < CACHE_DURATION) {
        return res.json(postsCache.data);
    }
    try {
        const postsRes = await axios.get(`${FB_API}/${PAGE_ID}/posts`, {
            params: {
                fields: 'message,created_time,full_picture,insights.metric(post_impressions_unique,post_engaged_users,post_reactions_like_total,post_clicks)',
                limit: 10,
                access_token: ACCESS_TOKEN
            }
        });

        const posts = postsRes.data.data.map(post => {
            const ins = {};
            if (post.insights && post.insights.data) {
                post.insights.data.forEach(m => { ins[m.name] = m.values?.[0]?.value || 0; });
            }
            return {
                id: post.id,
                message: post.message || '',
                created_time: post.created_time,
                image: post.full_picture || null,
                reach: ins['post_impressions_unique'] || 0,
                engaged: ins['post_engaged_users'] || 0,
                likes: ins['post_reactions_like_total'] || 0,
                clicks: ins['post_clicks'] || 0
            };
        });

        posts.sort((a, b) => b.reach - a.reach);
        console.log(`✅ Top posts loaded: ${posts.length} posts`);

        const result = { success: true, posts };
        postsCache = { data: result, timestamp: Date.now() };
        res.json(result);

    } catch (error) {
        console.error('⚠️ Top posts error:', error.response?.data || error.message);
        res.json(postsCache.data || { success: false, posts: [] });
    }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Prof Solar FB Marketing Server running on http://localhost:${PORT}`);
    console.log(`📄 Page ID: ${PAGE_ID}`);
    console.log(`🔑 Token: ${ACCESS_TOKEN.substring(0, 20)}...`);
});
