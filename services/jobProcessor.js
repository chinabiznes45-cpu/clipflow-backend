// services/jobProcessor.js
// Orchestrates the full ClipFlow automation pipeline:
// upload → process → select assets → post to all platforms

const { getDb, getRandom, addLog, updateJob } = require('../db/database');
const { processVideo } = require('./videoProcessor');
const { postToTikTok }     = require('./tiktokPoster');
const { postToYouTube }    = require('./youtubePoster');
const { postToInstagram }  = require('./instagramPoster');

// In-memory queue (replace with Redis/Bull for production)
const queue = [];
let isProcessing = false;

/**
 * Add a job to the queue and start processing
 */
function enqueueJob(jobId) {
  queue.push(jobId);
  addLog(jobId, 'info', `Job queued (position: ${queue.length})`, 'system');

  // Start processor if not running
  if (!isProcessing) processNext();
}

async function processNext() {
  if (queue.length === 0) {
    isProcessing = false;
    return;
  }
  isProcessing = true;
  const jobId = queue.shift();
  await runJob(jobId);
  processNext(); // process next in queue
}

/**
 * Run full pipeline for a single job
 */
async function runJob(jobId) {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return;

  addLog(jobId, 'info', '=== ClipFlow Job Started ===', 'system');

  try {
    // ── STEP 1: Select random assets ─────────────────────────────────────
    updateJob(jobId, { status: 'processing' });

    const sentence    = getRandom('sentences');
    const description = getRandom('descriptions');
    const thumbnail   = getRandom('thumbnails');

    if (!sentence || !description) {
      throw new Error('Missing sentences or descriptions in database. Please add some first.');
    }

    // Store selected assets on the job
    updateJob(jobId, {
      sentence_id:       sentence?.id,
      description_id:    description?.id,
      thumbnail_id:      thumbnail?.id,
      sentence_text:     sentence?.text,
      description_text:  description?.text,
      thumbnail_path:    thumbnail?.filepath || null,
    });

    addLog(jobId, 'info', `Selected sentence: "${sentence.text}"`, 'system');
    addLog(jobId, 'info', `Selected description: "${description.text.substring(0, 60)}…"`, 'system');
    addLog(jobId, 'info', `Selected thumbnail: ${thumbnail?.filename || 'none'}`, 'system');

    // ── STEP 2: Process video ────────────────────────────────────────────
    const finalVideoPath = await processVideo(job.original_file, sentence.text, jobId);
    updateJob(jobId, { generated_file: finalVideoPath, status: 'processed' });

    // ── STEP 3: Fetch profile ────────────────────────────────────────────
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(job.profile_id);
    if (!profile) throw new Error(`Profile not found: ${job.profile_id}`);

    // ── STEP 4: Post to all platforms ────────────────────────────────────
    updateJob(jobId, { status: 'posting' });

    const postArgs = [profile, finalVideoPath, description.text, thumbnail?.filepath || null, jobId];

    // Post concurrently to all 3 platforms
    const [tiktokResult, youtubeResult, instagramResult] = await Promise.allSettled([
      postToTikTok(...postArgs),
      postToYouTube(...postArgs),
      postToInstagram(...postArgs),
    ]);

    // Collect results
    const updates = {};

    if (tiktokResult.status === 'fulfilled') {
      const r = tiktokResult.value;
      updates.tiktok_status  = r.success ? 'success' : 'failed';
      updates.tiktok_post_id = r.postId || null;
    } else {
      updates.tiktok_status = 'failed';
      addLog(jobId, 'error', `TikTok unhandled error: ${tiktokResult.reason}`, 'tiktok');
    }

    if (youtubeResult.status === 'fulfilled') {
      const r = youtubeResult.value;
      updates.youtube_status  = r.success ? 'success' : 'failed';
      updates.youtube_post_id = r.postId || null;
    } else {
      updates.youtube_status = 'failed';
      addLog(jobId, 'error', `YouTube unhandled error: ${youtubeResult.reason}`, 'youtube');
    }

    if (instagramResult.status === 'fulfilled') {
      const r = instagramResult.value;
      updates.instagram_status  = r.success ? 'success' : 'failed';
      updates.instagram_post_id = r.postId || null;
    } else {
      updates.instagram_status = 'failed';
      addLog(jobId, 'error', `Instagram unhandled error: ${instagramResult.reason}`, 'instagram');
    }

    // Determine overall status
    const anySuccess = [updates.tiktok_status, updates.youtube_status, updates.instagram_status]
      .some(s => s === 'success');
    const allFailed  = [updates.tiktok_status, updates.youtube_status, updates.instagram_status]
      .every(s => s === 'failed');

    updates.status = allFailed ? 'failed' : 'done';
    updateJob(jobId, updates);

    addLog(jobId, allFailed ? 'error' : 'success',
      `=== Job Complete — TikTok:${updates.tiktok_status} YouTube:${updates.youtube_status} Instagram:${updates.instagram_status} ===`,
      'system'
    );

  } catch (err) {
    addLog(jobId, 'error', `Job failed: ${err.message}`, 'system');
    updateJob(jobId, { status: 'failed', error_message: err.message });
  }
}

/**
 * Retry a failed job (resets status and re-queues)
 */
function retryJob(jobId) {
  const db = getDb();
  db.prepare(`
    UPDATE jobs SET
      status = 'pending',
      tiktok_status = 'pending',
      youtube_status = 'pending',
      instagram_status = 'pending',
      error_message = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(jobId);
  addLog(jobId, 'info', 'Job requeued for retry', 'system');
  enqueueJob(jobId);
}

function getQueueStatus() {
  return { queueLength: queue.length, isProcessing };
}

module.exports = { enqueueJob, retryJob, getQueueStatus };
