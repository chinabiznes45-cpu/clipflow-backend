// services/videoProcessor.js
// Handles all FFmpeg video processing for ClipFlow
// Pipeline: upload → vertical crop → duplicate+merge → speed up → text overlay → export

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { addLog } = require('../db/database');

require('dotenv').config();

// Set ffmpeg paths from env if provided
if (process.env.FFMPEG_PATH)  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

const TARGET_WIDTH  = parseInt(process.env.VIDEO_WIDTH)  || 1080;
const TARGET_HEIGHT = parseInt(process.env.VIDEO_HEIGHT) || 1920;
const VIDEO_SPEED   = parseFloat(process.env.VIDEO_SPEED) || 15;

const GENERATED_DIR = process.env.GENERATED_DIR
  ? path.resolve(__dirname, '..', process.env.GENERATED_DIR)
  : path.join(__dirname, '../../generated');

if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

/**
 * Main processing pipeline
 * @param {string} inputPath  - path to original uploaded video
 * @param {string} sentence   - text overlay sentence
 * @param {string} jobId      - for logging
 * @returns {Promise<string>} - path to final MP4
 */
async function processVideo(inputPath, sentence, jobId) {
  addLog(jobId, 'info', `Starting video processing pipeline`, 'system');

  const baseName  = `job_${jobId}`;
  const step1Path = path.join(GENERATED_DIR, `${baseName}_step1_vertical.mp4`);
  const step2Path = path.join(GENERATED_DIR, `${baseName}_step2_merged.mp4`);
  const step3Path = path.join(GENERATED_DIR, `${baseName}_step3_speed.mp4`);
  const finalPath = path.join(GENERATED_DIR, `${baseName}_final.mp4`);

  try {
    // STEP 1 – Convert to 9:16 vertical (1080×1920)
    addLog(jobId, 'info', 'Step 1/4: Converting to 9:16 vertical format', 'system');
    await convertToVertical(inputPath, step1Path);

    // STEP 2 – Duplicate and merge (video + copy of itself)
    addLog(jobId, 'info', 'Step 2/4: Duplicating and merging video', 'system');
    await duplicateAndMerge(step1Path, step2Path, jobId);

    // STEP 3 – Speed up to 15x
    addLog(jobId, 'info', `Step 3/4: Speeding up to ${VIDEO_SPEED}x`, 'system');
    await speedUpVideo(step2Path, step3Path, VIDEO_SPEED);

    // STEP 4 – Overlay text sentence
    addLog(jobId, 'info', 'Step 4/4: Overlaying text sentence', 'system');
    await overlayText(step3Path, finalPath, sentence);

    // Cleanup intermediate files
    [step1Path, step2Path, step3Path].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    addLog(jobId, 'success', `Video processing complete → ${path.basename(finalPath)}`, 'system');
    return finalPath;

  } catch (err) {
    addLog(jobId, 'error', `Video processing failed: ${err.message}`, 'system');
    throw err;
  }
}

// ── Step 1: Convert to vertical 9:16 ──────────────────────────────────────
function convertToVertical(input, output) {
  return new Promise((resolve, reject) => {
    // Scale+crop to fill 1080x1920, preserving aspect ratio
    // If landscape: scale height to 1920, crop width to 1080 (center crop)
    // If portrait: scale width to 1080, crop height to 1920
    const vf = [
      `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase`,
      `crop=${TARGET_WIDTH}:${TARGET_HEIGHT}`,
      `setsar=1`
    ].join(',');

    ffmpeg(input)
      .videoFilter(vf)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
      ])
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── Step 2: Duplicate + merge video with itself ────────────────────────────
async function duplicateAndMerge(input, output, jobId) {
  // Write a concat list file
  const listPath = path.join(GENERATED_DIR, `concat_${jobId}.txt`);
  const escaped  = input.replace(/'/g, "'\\''");
  fs.writeFileSync(listPath, `file '${escaped}'\nfile '${escaped}'\n`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
      ])
      .output(output)
      .on('end', () => {
        fs.unlinkSync(listPath);
        resolve();
      })
      .on('error', (err) => {
        if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
        reject(err);
      })
      .run();
  });
}

// ── Step 3: Speed up video ─────────────────────────────────────────────────
// FFmpeg atempo filter maxes at 2.0x per filter, so we chain for higher speeds
// For 15x: chain multiple atempo filters (2.0 * 2.0 * 2.0 * 1.875 = 15)
function buildAtempoChain(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  if (remaining > 1.0) filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(',');
}

function speedUpVideo(input, output, speed) {
  return new Promise((resolve, reject) => {
    const atempoChain = buildAtempoChain(speed);
    ffmpeg(input)
      .videoFilter(`setpts=${(1 / speed).toFixed(6)}*PTS`)
      .audioFilter(atempoChain)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-movflags +faststart',
      ])
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── Step 4: Overlay text with elegant styling ──────────────────────────────
function overlayText(input, output, text) {
  return new Promise((resolve, reject) => {
    // Random vertical position between 40% and 65% of screen height
    const yPositions = [
      `(h*0.40)`, `(h*0.45)`, `(h*0.50)`, `(h*0.55)`, `(h*0.60)`,
    ];
    const yPos = yPositions[Math.floor(Math.random() * yPositions.length)];

    // Escape special characters in text for ffmpeg drawtext
    const safeText = text
      .replace(/'/g, "\u2019")   // curly apostrophe
      .replace(/:/g, '\\:')
      .replace(/\\/g, '\\\\');

    // Elegant drawtext filter
    // Uses a clean bold font, white text, soft shadow for depth
    const drawtextFilter = [
      `drawtext=`,
      `text='${safeText}':`,
      `fontsize=58:`,
      `fontcolor=white:`,
      `font=DejaVu-Sans-Bold:`,
      `x=(w-text_w)/2:`,
      `y=${yPos}:`,
      `shadowcolor=black@0.7:`,
      `shadowx=2:`,
      `shadowy=2:`,
      `borderw=3:`,
      `bordercolor=black@0.5:`,
      `line_spacing=8:`,
      `expansion=normal`,
    ].join('');

    ffmpeg(input)
      .videoFilter(drawtextFilter)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a copy',
        '-movflags +faststart',
      ])
      .output(output)
      .on('end', resolve)
      .on('error', (err) => {
        // Fallback: if drawtext fails (font not found), skip text overlay
        console.warn(`⚠️  drawtext failed, skipping overlay: ${err.message}`);
        fs.copyFileSync(input, output);
        resolve();
      })
      .run();
  });
}

/**
 * Get video metadata
 */
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

module.exports = { processVideo, getVideoInfo };
