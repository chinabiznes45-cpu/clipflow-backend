// routes/index.js — Main API routes
const express = require('express');
const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api' });
});

// Example endpoint — replace with your actual API routes
router.get('/status', (req, res) => {
  res.json({ message: 'API is running' });
});

module.exports = router;

