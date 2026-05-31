// services/instagramPoster.js
// Posts videos as Instagram Reels using the Instagram Graph API.
// Fallback to Playwright/Puppeteer automation if API unavailable.

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { addLog } = require('../db/database');

require('dotenv').config();

const APP_ID     = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const GRAPH_BASE = 'https://graph.instagram.com';

/**
 * Post a video as Instagram Reel for a given profile.
 */
async function postToInstagram(profile, videoPath, description, thumbnailPath, jobId) {
  addLog(jobId, 'info', `Instagram: Starting post for profile "${profile.name}"`, 'instagram');

  if (profile.instagram_token) {
    try {
      const result = await postViaGraphAPI(profile, videoPath, description, thumbnailPath, jobId);
      return result;
    } catch (err) {
      addLog(jobId, 'warn', `Instagram Graph API failed: ${err.message}. Trying automation…`, 'instagram');
    }
  }

  if (profile.instagram_session) {
    try {
      return await postViaPuppeteer(profile, videoPath, description, thumbnailPath, jobId);
    } catch (err) {
      addLog(jobId, 'error', `Instagram automation failed: ${err.message}`, 'instagram');
      return { success: false, error: err.message };
    }
  }

  addLog(jobId, 'error', 'Instagram: No token or session configured', 'instagram');
  return { success: false, error: 'No Instagram credentials configured' };
}

// ── Instagram Graph API (Business/Creator accounts only) ─────────────────
// Docs: https://developers.facebook.com/docs/instagram-api/guides/reels
async function postViaGraphAPI(profile, videoPath, description, thumbnailPath, jobId) {
  const tokenData  = JSON.parse(profile.instagram_token);
  const accessToken = tokenData.access_token;
  const igUserId    = tokenData.user_id;

  addLog(jobId, 'info', `Instagram: Using Graph API (user: ${igUserId})`, 'instagram');

  // NOTE: Instagram Graph API requires the video to be publicly accessible via URL.
  // In production, upload to your own CDN/S3 and use that URL here.
  // For MVP, we use a placeholder URL that should be replaced with real hosting.
  const videoUrl = tokenData.cdn_base_url
    ? `${tokenData.cdn_base_url}/${path.basename(videoPath)}`
    : `http://YOUR_SERVER_URL/generated/${path.basename(videoPath)}`;

  addLog(jobId, 'info', 'Instagram: Creating media container…', 'instagram');

  // STEP 1 – Create Reels container
  const containerRes = await axios.post(
    `${GRAPH_BASE}/v19.0/${igUserId}/media`,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: description.substring(0, 2200),
      share_to_feed: true,
    },
    { params: { access_token: accessToken } }
  );

  if (!containerRes.data.id) {
    throw new Error(`Container creation failed: ${JSON.stringify(containerRes.data)}`);
  }

  const containerId = containerRes.data.id;
  addLog(jobId, 'info', `Instagram: Container created (${containerId}), waiting for processing…`, 'instagram');

  // STEP 2 – Wait for container status = FINISHED
  await pollContainerStatus(accessToken, containerId, jobId);

  // STEP 3 – Publish
  addLog(jobId, 'info', 'Instagram: Publishing Reel…', 'instagram');
  const publishRes = await axios.post(
    `${GRAPH_BASE}/v19.0/${igUserId}/media_publish`,
    { creation_id: containerId },
    { params: { access_token: accessToken } }
  );

  const postId = publishRes.data.id;
  addLog(jobId, 'success', `Instagram: Reel published (id: ${postId})`, 'instagram');
  return { success: true, postId };
}

async function pollContainerStatus(accessToken, containerId, jobId, maxTries = 24) {
  for (let i = 0; i < maxTries; i++) {
    await sleep(10000); // poll every 10s
    const res = await axios.get(`${GRAPH_BASE}/v19.0/${containerId}`, {
      params: { fields: 'status_code,status', access_token: accessToken },
    });
    const status = res.data.status_code;
    addLog(jobId, 'info', `Instagram: Container status ${i + 1} → ${status}`, 'instagram');
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Instagram container ${status}: ${JSON.stringify(res.data)}`);
    }
  }
  throw new Error('Instagram: Container processing timed out');
}

// ── Puppeteer Fallback ────────────────────────────────────────────────────
async function postViaPuppeteer(profile, videoPath, description, thumbnailPath, jobId) {
  addLog(jobId, 'info', 'Instagram: Using Puppeteer automation fallback', 'instagram');

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

    // Restore Instagram session cookies
    const cookies = JSON.parse(profile.instagram_session);
    await page.setCookie(...cookies);

    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 60000 });

    // Check login status
    const profileLink = await page.$('a[href*="/accounts/"]');
    if (!profileLink) throw new Error('Instagram session expired — please re-authenticate');

    // Navigate to create post
    const createBtn = await page.$('[aria-label="New post"]');
    if (createBtn) await createBtn.click();

    addLog(jobId, 'info', 'Instagram: Automation — navigated to create post', 'instagram');
    // NOTE: Full Instagram automation is complex due to frequent UI changes.
    // This is a simplified stub. In production, use a maintained Playwright script
    // or a service like Instauto (https://github.com/mifi/instauto).

    addLog(jobId, 'warn', 'Instagram: Puppeteer automation requires manual verification steps. Consider using the official Graph API for a Business account.', 'instagram');
    return { success: false, error: 'Instagram Puppeteer automation requires additional setup. See logs.' };

  } finally {
    await browser.close();
  }
}

/**
 * Get OAuth authorization URL for Instagram Graph API
 */
function getAuthUrl() {
  return `https://api.instagram.com/oauth/authorize`
    + `?client_id=${APP_ID}`
    + `&redirect_uri=${encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI)}`
    + `&scope=instagram_basic,instagram_content_publish,pages_read_engagement`
    + `&response_type=code`;
}

async function getTokensFromCode(code) {
  const res = await axios.post('https://api.instagram.com/oauth/access_token', {
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: process.env.INSTAGRAM_REDIRECT_URI,
    code,
  }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { postToInstagram, getAuthUrl, getTokensFromCode };
