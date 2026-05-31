// services/tiktokPoster.js
// Posts videos to TikTok using the official Content Posting API,
// with a Puppeteer browser automation fallback.

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { addLog } = require('../db/database');

require('dotenv').config();

/**
 * Post a video to TikTok for a given profile.
 * @param {object} profile       - Profile row from DB (includes tiktok_token, tiktok_session)
 * @param {string} videoPath     - Path to final MP4
 * @param {string} description   - Caption/description text
 * @param {string} thumbnailPath - Path to thumbnail image
 * @param {string} jobId         - For logging
 * @returns {Promise<{success:boolean, postId?:string, error?:string}>}
 */
async function postToTikTok(profile, videoPath, description, thumbnailPath, jobId) {
  addLog(jobId, 'info', `TikTok: Starting post for profile "${profile.name}"`, 'tiktok');

  // Try official API first if token exists
  if (profile.tiktok_token) {
    try {
      const result = await postViaAPI(profile, videoPath, description, thumbnailPath, jobId);
      return result;
    } catch (err) {
      addLog(jobId, 'warn', `TikTok API failed: ${err.message}. Trying automation fallback…`, 'tiktok');
    }
  }

  // Fallback to Puppeteer automation if session exists
  if (profile.tiktok_session) {
    try {
      const result = await postViaPuppeteer(profile, videoPath, description, thumbnailPath, jobId);
      return result;
    } catch (err) {
      addLog(jobId, 'error', `TikTok automation failed: ${err.message}`, 'tiktok');
      return { success: false, error: err.message };
    }
  }

  addLog(jobId, 'error', 'TikTok: No token or session configured for this profile', 'tiktok');
  return { success: false, error: 'No TikTok credentials configured' };
}

// ── Official TikTok Content Posting API v2 ────────────────────────────────
// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started/
async function postViaAPI(profile, videoPath, description, thumbnailPath, jobId) {
  const token   = JSON.parse(profile.tiktok_token);
  const accessToken = token.access_token;

  addLog(jobId, 'info', 'TikTok: Using official Content Posting API', 'tiktok');

  const fileSize = fs.statSync(videoPath).size;

  // STEP 1 – Initialize upload
  const initRes = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/video/init/',
    {
      post_info: {
        title: description.substring(0, 2200),
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fileSize,
        chunk_size: fileSize,
        total_chunk_count: 1,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
    }
  );

  if (initRes.data.error?.code !== 'ok') {
    throw new Error(`TikTok init failed: ${JSON.stringify(initRes.data.error)}`);
  }

  const { publish_id, upload_url } = initRes.data.data;
  addLog(jobId, 'info', `TikTok: Upload initialized (publish_id: ${publish_id})`, 'tiktok');

  // STEP 2 – Upload video binary
  const videoBuffer = fs.readFileSync(videoPath);
  await axios.put(upload_url, videoBuffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
      'Content-Length': fileSize,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  addLog(jobId, 'info', 'TikTok: Video uploaded, polling for status…', 'tiktok');

  // STEP 3 – Poll for completion
  const postId = await pollTikTokStatus(accessToken, publish_id, jobId);
  addLog(jobId, 'success', `TikTok: Posted successfully (publish_id: ${postId})`, 'tiktok');
  return { success: true, postId };
}

async function pollTikTokStatus(accessToken, publishId, jobId, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    await sleep(5000);
    const res = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      { publish_id: publishId },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    const status = res.data?.data?.status;
    addLog(jobId, 'info', `TikTok: Status poll ${i + 1} → ${status}`, 'tiktok');
    if (status === 'PUBLISH_COMPLETE') return publishId;
    if (status === 'FAILED') throw new Error(`TikTok publish failed: ${JSON.stringify(res.data)}`);
  }
  throw new Error('TikTok: Publish timed out');
}

// ── Puppeteer Fallback ────────────────────────────────────────────────────
async function postViaPuppeteer(profile, videoPath, description, thumbnailPath, jobId) {
  addLog(jobId, 'info', 'TikTok: Using Puppeteer automation fallback', 'tiktok');

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error('Puppeteer not installed. Run: npm install puppeteer');
  }

  const browser = await puppeteer.launch({
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Restore cookies/session
    const cookies = JSON.parse(profile.tiktok_session);
    await page.setCookie(...cookies);

    await page.goto('https://www.tiktok.com/upload', { waitUntil: 'networkidle2', timeout: 60000 });

    // Check if logged in
    const isLoggedIn = await page.$('[data-e2e="upload-icon"]');
    if (!isLoggedIn) throw new Error('TikTok session expired — please re-authenticate in Profile Manager');

    // Upload video file
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('Could not find file input on TikTok upload page');
    await fileInput.uploadFile(videoPath);

    // Wait for upload to process
    await page.waitForSelector('[class*="caption"]', { timeout: 120000 });

    // Type description
    await page.click('[class*="caption"]');
    await page.keyboard.type(description.substring(0, 2200));

    // Click Post button
    await page.waitForSelector('[class*="btn-post"]', { timeout: 30000 });
    await page.click('[class*="btn-post"]');

    // Wait for success
    await page.waitForNavigation({ timeout: 60000 });
    addLog(jobId, 'success', 'TikTok: Puppeteer post completed', 'tiktok');

    // Save updated cookies
    const updatedCookies = await page.cookies();
    return { success: true, postId: 'puppeteer_post', updatedCookies };

  } finally {
    await browser.close();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { postToTikTok };
