// server.js — ClipFlow Backend
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const apiRoutes  = require('./routes/index');
const authRoutes = require('./routes/auth');
const { getDb }  = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3001;

// Open CORS — allows Capacitor app (capacitor://localhost) and any browser to connect
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/generated',  express.static(path.join(__dirname, '../generated')));
app.use('/thumbnails', express.static(path.join(__dirname, '../thumbnails')));

app.use('/api', apiRoutes);
app.use('/auth', authRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), version: '1.0.0' });
});

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message || 'Internal server error' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎬 ClipFlow Backend → http://0.0.0.0:${PORT}`);
  getDb();
});

module.exports = app;
