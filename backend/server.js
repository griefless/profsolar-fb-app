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
        // Use local server time string for comparison so scheduled_time (local) aligns correctly.
        // We store scheduled_time as local ISO string (e.g. 2026-06-02T08:00:00) from the frontend.
        // Compare against local time, not UTC, to avoid timezone offset mismatches.
        const now = new Date();
        // Build a local ISO-like string: YYYY-MM-DDTHH:MM:SS
        const pad = n => String(n).padStart(2, '0');
        const localNow = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        const duePosts = await dbAll(
            `SELECT * FROM posts WHERE status='scheduled' AND scheduled_time<=?`,
            [localNow]
        );
        if (duePosts.length > 0) {
            console.log(`⏰ Cron: ${duePosts.length} post(s) due at ${localNow}`);
        }
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

        // 2. Daily insights — only use metrics confirmed working for this page
        let metrics = [];
        // Try each metric individually; skip any that Facebook rejects
        const allMetrics = [
            'page_video_views',
            'page_impressions_unique',
            'page_impressions',
            'page_engaged_users',
            'page_fan_adds',
            'page_fan_removes',
            'page_daily_follows',
            'page_daily_unfollows_unique',
        ];
        for (const metric of allMetrics) {
            try {
                const insightsRes = await axios.get(`${FB_API}/${PAGE_ID}/insights`, {
                    params: {
                        metric,
                        period: 'day',
                        since,
                        until,
                        access_token: ACCESS_TOKEN
                    }
                });
                if (insightsRes.data.data && insightsRes.data.data.length > 0) {
                    metrics = metrics.concat(insightsRes.data.data);
                    console.log(`✅ Metric OK: ${metric}`);
                }
            } catch (insightErr) {
                const errMsg = insightErr.response?.data?.error?.message || insightErr.message;
                console.warn(`⚠️ Metric unavailable [${metric}]: ${errMsg}`);
            }
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
        // Use direct engagement fields instead of deprecated insights metrics
        const postsRes = await axios.get(`${FB_API}/${PAGE_ID}/posts`, {
            params: {
                fields: 'message,created_time,full_picture,likes.summary(true),comments.summary(true),shares,reactions.summary(true)',
                limit: 10,
                access_token: ACCESS_TOKEN
            }
        });

        const posts = postsRes.data.data.map(post => {
            const likes    = post.likes?.summary?.total_count || 0;
            const comments = post.comments?.summary?.total_count || 0;
            const shares   = post.shares?.count || 0;
            const reactions = post.reactions?.summary?.total_count || 0;
            return {
                id: post.id,
                message: post.message || '',
                created_time: post.created_time,
                image: post.full_picture || null,
                reach: reactions + comments + shares,
                engaged: reactions + comments,
                likes,
                clicks: shares
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

// ==================== RECENT ACTIVITY ====================

let activityCache = { data: null, timestamp: 0 };

app.get('/api/activity', async (req, res) => {
    if (activityCache.data && Date.now() - activityCache.timestamp < CACHE_DURATION) {
        return res.json(activityCache.data);
    }
    try {
        const postsRes = await axios.get(`${FB_API}/${PAGE_ID}/posts`, {
            params: {
                fields: 'message,created_time,likes.summary(true),comments.summary(true),shares,full_picture',
                limit: 10,
                access_token: ACCESS_TOKEN
            }
        });

        const activities = [];
        for (const post of postsRes.data.data || []) {
            const likes    = post.likes?.summary?.total_count || 0;
            const comments = post.comments?.summary?.total_count || 0;
            const shares   = post.shares?.count || 0;
            const msg      = post.message ? post.message.substring(0, 60) + (post.message.length > 60 ? '...' : '') : 'Post';
            const timeAgo  = getTimeAgo(post.created_time);

            if (likes > 0)    activities.push({ icon: '❤️', color: 'rgba(239,68,68,0.15)',    title: `Post received ${likes} like${likes !== 1 ? 's' : ''}`,       subtitle: msg + ' · ' + timeAgo });
            if (comments > 0) activities.push({ icon: '💬', color: 'rgba(59,130,246,0.15)',   title: `${comments} comment${comments !== 1 ? 's' : ''} on your post`, subtitle: msg + ' · ' + timeAgo });
            if (shares > 0)   activities.push({ icon: '🔄', color: 'rgba(16,185,129,0.15)',   title: `Post shared ${shares} time${shares !== 1 ? 's' : ''}`,         subtitle: msg + ' · ' + timeAgo });
            if (likes === 0 && comments === 0 && shares === 0) {
                activities.push({ icon: '📝', color: 'rgba(245,158,11,0.15)', title: 'New post published', subtitle: msg + ' · ' + timeAgo });
            }
        }

        // Try website clicks metric
        let websiteClicks = 0;
        try {
            const since = Math.floor((Date.now() - 28 * 24 * 3600 * 1000) / 1000);
            const until = Math.floor(Date.now() / 1000);
            const clicksRes = await axios.get(`${FB_API}/${PAGE_ID}/insights`, {
                params: { metric: 'page_website_clicks_logged_in_unique', period: 'day', since, until, access_token: ACCESS_TOKEN }
            });
            const vals = clicksRes.data.data?.[0]?.values || [];
            websiteClicks = vals.reduce((a, v) => a + (v.value || 0), 0);
            console.log(`✅ Website clicks: ${websiteClicks}`);
        } catch (e) {
            console.warn('⚠️ Website clicks unavailable:', e.response?.data?.error?.message || e.message);
        }

        const result = { success: true, activities: activities.slice(0, 8), websiteClicks };
        activityCache = { data: result, timestamp: Date.now() };
        res.json(result);
    } catch (error) {
        console.error('⚠️ Activity error:', error.response?.data || error.message);
        res.json(activityCache.data || { success: false, activities: [], websiteClicks: 0 });
    }
});

function getTimeAgo(isoString) {
    const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
    if (diff < 3600)  return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return Math.floor(diff / 86400) + ' day' + (Math.floor(diff / 86400) !== 1 ? 's' : '') + ' ago';
}

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Prof Solar FB Marketing Server running on http://localhost:${PORT}`);
    console.log(`📄 Page ID: ${PAGE_ID}`);
    console.log(`🔑 Token: ${ACCESS_TOKEN.substring(0, 20)}...`);
});
