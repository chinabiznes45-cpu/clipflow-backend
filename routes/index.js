// routes/index.js
// All ClipFlow API route handlers

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb, addLog } = require('../db/database');
const { enqueueJob, retryJob, getQueueStatus } = require('../services/jobProcessor');

const router = express.Router();

// ── Storage configuration ──────────────────────────────────────────────────
const UPLOADS_DIR    = path.resolve(__dirname, '../../uploads');
const THUMBNAILS_DIR = path.resolve(__dirname, '../../thumbnails');
const GENERATED_DIR  = path.resolve(__dirname, '../../generated');

[UPLOADS_DIR, THUMBNAILS_DIR, GENERATED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${uuidv4()}${ext}`);
  },
});

const thumbStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, THUMBNAILS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `thumb_${uuidv4()}${ext}`);
  },
});

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Invalid video format. Allowed: mp4, mov, avi, mkv, webm'));
  },
}).single('video');

const uploadThumb = multer({ storage: thumbStorage, limits: { fileSize: 10 * 1024 * 1024 } }).single('thumbnail');

// ── JOBS / UPLOAD ──────────────────────────────────────────────────────────

// POST /api/upload  – Upload video + create job
router.post('/upload', (req, res) => {
  uploadVideo(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });

    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const db = getDb();
    const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const jobId = uuidv4();
    db.prepare(`
      INSERT INTO jobs (id, original_file, profile_id, status)
      VALUES (?, ?, ?, 'pending')
    `).run(jobId, req.file.path, profileId);

    addLog(jobId, 'info', `Video uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`, 'system');

    // Kick off the pipeline
    enqueueJob(jobId);

    res.json({ jobId, filename: req.file.filename, status: 'queued' });
  });
});

// GET /api/jobs  – List all jobs
router.get('/jobs', (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT j.*, p.name as profile_name
    FROM jobs j
    LEFT JOIN profiles p ON j.profile_id = p.id
    ORDER BY j.created_at DESC
    LIMIT 100
  `).all();
  res.json({ jobs, queue: getQueueStatus() });
});

// GET /api/jobs/:id  – Get single job
router.get('/jobs/:id', (req, res) => {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const logs = db.prepare('SELECT * FROM logs WHERE job_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ job, logs });
});

// POST /api/jobs/:id/retry
router.post('/jobs/:id/retry', (req, res) => {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  retryJob(req.params.id);
  res.json({ success: true, message: 'Job requeued for retry' });
});

// DELETE /api/jobs/:id
router.delete('/jobs/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM logs WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/generated/:filename  – Serve generated video
router.get('/generated/:filename', (req, res) => {
  const filePath = path.join(GENERATED_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// ── PROFILES ───────────────────────────────────────────────────────────────

// GET /api/profiles
router.get('/profiles', (req, res) => {
  const db = getDb();
  const profiles = db.prepare(`
    SELECT id, name, tiktok_account, youtube_account, instagram_account, is_active, created_at
    FROM profiles ORDER BY name
  `).all();
  res.json({ profiles });
});

// GET /api/profiles/active
router.get('/profiles/active', (req, res) => {
  const db = getDb();
  const profile = db.prepare('SELECT * FROM profiles WHERE is_active = 1').get();
  res.json({ profile: profile || null });
});

// POST /api/profiles
router.post('/profiles', (req, res) => {
  const { name, tiktok_account, youtube_account, instagram_account } = req.body;
  if (!name) return res.status(400).json({ error: 'Profile name is required' });
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO profiles (id, name, tiktok_account, youtube_account, instagram_account)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, tiktok_account || null, youtube_account || null, instagram_account || null);
  res.json({ success: true, id });
});

// PUT /api/profiles/:id
router.put('/profiles/:id', (req, res) => {
  const { name, tiktok_account, youtube_account, instagram_account } = req.body;
  const db = getDb();
  db.prepare(`
    UPDATE profiles SET name=?, tiktok_account=?, youtube_account=?, instagram_account=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, tiktok_account||null, youtube_account||null, instagram_account||null, req.params.id);
  res.json({ success: true });
});

// PUT /api/profiles/:id/activate
router.put('/profiles/:id/activate', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE profiles SET is_active = 0').run();
  db.prepare('UPDATE profiles SET is_active = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// DELETE /api/profiles/:id
router.delete('/profiles/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM profiles WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// PUT /api/profiles/:id/tokens  – Store OAuth tokens (called after OAuth callback)
router.put('/profiles/:id/tokens', (req, res) => {
  const { platform, token } = req.body; // platform: tiktok|youtube|instagram
  if (!['tiktok', 'youtube', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  const db = getDb();
  const col = `${platform}_token`;
  db.prepare(`UPDATE profiles SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(token), req.params.id);
  res.json({ success: true });
});

// ── SENTENCES ──────────────────────────────────────────────────────────────

router.get('/sentences', (req, res) => {
  const sentences = getDb().prepare('SELECT * FROM sentences ORDER BY id DESC').all();
  res.json({ sentences });
});

router.post('/sentences', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
  const db = getDb();
  const { lastInsertRowid } = db.prepare('INSERT INTO sentences (text) VALUES (?)').run(text.trim());
  res.json({ success: true, id: lastInsertRowid });
});

router.put('/sentences/:id', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
  getDb().prepare('UPDATE sentences SET text = ? WHERE id = ?').run(text.trim(), req.params.id);
  res.json({ success: true });
});

router.delete('/sentences/:id', (req, res) => {
  getDb().prepare('DELETE FROM sentences WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── DESCRIPTIONS ───────────────────────────────────────────────────────────

router.get('/descriptions', (req, res) => {
  const descriptions = getDb().prepare('SELECT * FROM descriptions ORDER BY id DESC').all();
  res.json({ descriptions });
});

router.post('/descriptions', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
  const { lastInsertRowid } = getDb().prepare('INSERT INTO descriptions (text) VALUES (?)').run(text.trim());
  res.json({ success: true, id: lastInsertRowid });
});

router.put('/descriptions/:id', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
  getDb().prepare('UPDATE descriptions SET text = ? WHERE id = ?').run(text.trim(), req.params.id);
  res.json({ success: true });
});

router.delete('/descriptions/:id', (req, res) => {
  getDb().prepare('DELETE FROM descriptions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── THUMBNAILS ─────────────────────────────────────────────────────────────

router.get('/thumbnails', (req, res) => {
  const thumbnails = getDb().prepare('SELECT * FROM thumbnails ORDER BY id DESC').all();
  res.json({ thumbnails });
});

router.post('/thumbnails', (req, res) => {
  uploadThumb(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const { label } = req.body;
    const db = getDb();
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO thumbnails (filename, filepath, label) VALUES (?, ?, ?)'
    ).run(req.file.filename, req.file.path, label || req.file.originalname);
    res.json({ success: true, id: lastInsertRowid, filename: req.file.filename });
  });
});

router.delete('/thumbnails/:id', (req, res) => {
  const db = getDb();
  const thumb = db.prepare('SELECT * FROM thumbnails WHERE id = ?').get(req.params.id);
  if (thumb && fs.existsSync(thumb.filepath)) fs.unlinkSync(thumb.filepath);
  db.prepare('DELETE FROM thumbnails WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Serve thumbnail images
router.get('/thumbnails/:filename', (req, res) => {
  const filePath = path.join(THUMBNAILS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// ── LOGS ───────────────────────────────────────────────────────────────────

router.get('/logs', (req, res) => {
  const db = getDb();
  const limit  = parseInt(req.query.limit)  || 200;
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare(`
    SELECT l.*, j.original_file
    FROM logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json({ logs });
});

router.delete('/logs', (req, res) => {
  getDb().prepare('DELETE FROM logs').run();
  res.json({ success: true });
});

// ── STATS ──────────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  const db = getDb();
  const stats = {
    totalJobs:      db.prepare('SELECT COUNT(*) as c FROM jobs').get().c,
    doneJobs:       db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='done'").get().c,
    failedJobs:     db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='failed'").get().c,
    processingJobs: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('pending','processing','posting')").get().c,
    profiles:       db.prepare('SELECT COUNT(*) as c FROM profiles').get().c,
    sentences:      db.prepare('SELECT COUNT(*) as c FROM sentences').get().c,
    descriptions:   db.prepare('SELECT COUNT(*) as c FROM descriptions').get().c,
    thumbnails:     db.prepare('SELECT COUNT(*) as c FROM thumbnails').get().c,
  };
  res.json(stats);
});

module.exports = router;
