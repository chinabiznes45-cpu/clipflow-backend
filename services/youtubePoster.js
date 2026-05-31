// services/youtubePoster.js
// Posts videos as YouTube Shorts using the YouTube Data API v3.
// Shorts = vertical video ≤60s + #Shorts in title or description.

const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { addLog } = require('../db/database');

require('dotenv').config();

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3001/auth/youtube/callback';

/**
 * Post a video to YouTube Shorts for a given profile.
 */
async function postToYouTube(profile, videoPath, description, thumbnailPath, jobId) {
  addLog(jobId, 'info', `YouTube: Starting post for profile "${profile.name}"`, 'youtube');

  if (!profile.youtube_token) {
    addLog(jobId, 'error', 'YouTube: No OAuth token configured for this profile', 'youtube');
    return { success: false, error: 'No YouTube credentials configured' };
  }

  try {
    const result = await uploadVideo(profile, videoPath, description, thumbnailPath, jobId);
    return result;
  } catch (err) {
    addLog(jobId, 'error', `YouTube upload failed: ${err.message}`, 'youtube');
    return { success: false, error: err.message };
  }
}

async function uploadVideo(profile, videoPath, description, thumbnailPath, jobId) {
  // Build OAuth2 client with stored tokens
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const tokenData = JSON.parse(profile.youtube_token);
  oauth2Client.setCredentials(tokenData);

  // Auto-refresh token if expired
  oauth2Client.on('tokens', (tokens) => {
    // In production, save new tokens back to DB here
    addLog(jobId, 'info', 'YouTube: Token refreshed', 'youtube');
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // Prepend #Shorts to ensure YouTube treats it as a Short
  const title = `${description.substring(0, 90)} #Shorts`.trim();
  const body  = `${description}\n\n#Shorts #viral #trending`;

  addLog(jobId, 'info', 'YouTube: Uploading video…', 'youtube');

  // STEP 1 – Upload video
  const videoRes = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.substring(0, 100),
        description: body.substring(0, 5000),
        tags: extractHashtags(description),
        categoryId: '22', // People & Blogs (common for Shorts)
        defaultLanguage: 'en',
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath),
    },
  });

  const videoId = videoRes.data.id;
  addLog(jobId, 'info', `YouTube: Video uploaded (videoId: ${videoId})`, 'youtube');

  // STEP 2 – Set thumbnail if available
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: 'image/jpeg',
          body: fs.createReadStream(thumbnailPath),
        },
      });
      addLog(jobId, 'info', 'YouTube: Thumbnail set', 'youtube');
    } catch (thumbErr) {
      addLog(jobId, 'warn', `YouTube: Thumbnail upload failed (non-fatal): ${thumbErr.message}`, 'youtube');
    }
  }

  addLog(jobId, 'success', `YouTube: Posted as Short → https://youtube.com/shorts/${videoId}`, 'youtube');
  return { success: true, postId: videoId };
}

/**
 * Generate OAuth2 authorization URL for connecting a YouTube account
 */
function getAuthUrl() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
    ],
  });
}

/**
 * Exchange authorization code for tokens
 */
async function getTokensFromCode(code) {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

// Extract hashtags from description text
function extractHashtags(text) {
  const matches = text.match(/#\w+/g) || [];
  return matches.map(t => t.slice(1)).slice(0, 500);
}

module.exports = { postToYouTube, getAuthUrl, getTokensFromCode };
