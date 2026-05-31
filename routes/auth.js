// routes/auth.js
// OAuth callback handlers for YouTube and Instagram

const express = require('express');
const { getDb } = require('../db/database');
const { getTokensFromCode: ytGetTokens } = require('../services/youtubePoster');
const { getTokensFromCode: igGetTokens, getAuthUrl: igGetAuthUrl } = require('../services/instagramPoster');
const { getAuthUrl: ytGetAuthUrl } = require('../services/youtubePoster');

const router = express.Router();

// GET /auth/youtube  – Redirect to YouTube OAuth
router.get('/youtube', (req, res) => {
  const { profileId } = req.query;
  if (!profileId) return res.status(400).send('profileId required');
  // Store profileId in state param (in production, use a signed token)
  const url = ytGetAuthUrl() + `&state=${profileId}`;
  res.redirect(url);
});

// GET /auth/youtube/callback  – YouTube OAuth callback
router.get('/youtube/callback', async (req, res) => {
  const { code, state: profileId } = req.query;
  if (!code || !profileId) return res.status(400).send('Missing code or state');
  try {
    const tokens = await ytGetTokens(code);
    const db = getDb();
    db.prepare(`UPDATE profiles SET youtube_token = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(tokens), profileId);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff">
        <h2>✅ YouTube connected successfully!</h2>
        <p>You can close this window.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// GET /auth/instagram  – Redirect to Instagram OAuth
router.get('/instagram', (req, res) => {
  const { profileId } = req.query;
  if (!profileId) return res.status(400).send('profileId required');
  const url = igGetAuthUrl() + `&state=${profileId}`;
  res.redirect(url);
});

// GET /auth/instagram/callback  – Instagram OAuth callback
router.get('/instagram/callback', async (req, res) => {
  const { code, state: profileId } = req.query;
  if (!code || !profileId) return res.status(400).send('Missing code or state');
  try {
    const tokens = await igGetTokens(code);
    const db = getDb();
    db.prepare(`UPDATE profiles SET instagram_token = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(tokens), profileId);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff">
        <h2>✅ Instagram connected successfully!</h2>
        <p>You can close this window.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

module.exports = router;
