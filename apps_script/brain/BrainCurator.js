/**
 * BrainCurator.js — scans the Ads Agent Brain Drive folder, extracts text
 * from new files, calls Groq to generate structured metadata, and writes
 * Brain sheet entries.
 *
 * Idempotent: dedup by Drive file ID. Re-running only processes new files.
 *
 * Supported file types:
 *   - Plain text       (.txt, .md) — read directly
 *   - Google Docs      — DocumentApp.openById().getBody().getText()
 *   - Google Sheets    — first sheet, concatenated cell values (best-effort)
 *   - PDF              — converted via Drive Advanced Service (Drive.Files.copy
 *                        with target mimeType = google-apps.document, then
 *                        DocumentApp). Requires Advanced Drive Service enabled.
 *   - Word .docx       — same conversion path as PDF
 *
 * Anything else is logged as "skipped".
 *
 * Per-run cap: 30 files. If you've uploaded more, re-run.
 *
 * Setup (one-time, before first run):
 *   1. In the Apps Script editor, click "+" next to "Services" (left sidebar)
 *   2. Find "Drive API" → version v2 → click Add
 *   3. The identifier should be "Drive" (capital D)
 *   This enables PDF/DOCX → Doc conversion.
 */

/* ===========================================================================
 * Public entry points
 * ========================================================================= */

const MAX_FILES_PER_RUN = 30;
const MAX_RAW_CHARS     = 30000;   // cap extracted text before sending to LLM
const MAX_SUMMARY_INPUT = 12000;   // chars of file text passed to extractor

function refreshBrain() {
  log_('brain', '═══════════════════════════════════════════');
  log_('brain', 'BrainCurator refresh starting');
  log_('brain', '═══════════════════════════════════════════');

  const folderId = PROPS.require('BRAIN_DRIVE_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  log_('brain', `Brain folder: "${folder.getName()}" (${folderId})`);

  const existing = BrainStore.existingSources();
  log_('brain', `Already indexed: ${existing.size} entries`);

  const allFiles = collectFiles_(folder);
  log_('brain', `Files in folder: ${allFiles.length}`);

  const newFiles = allFiles.filter(f => !existing.has(f.getId()));
  log_('brain', `New files to process: ${newFiles.length}`);

  if (newFiles.length === 0) {
    log_('brain', 'Nothing to do. Drop files into the Drive folder and re-run.');
    return { processed: 0, skipped: 0, failed: 0 };
  }

  const slice = newFiles.slice(0, MAX_FILES_PER_RUN);
  if (newFiles.length > MAX_FILES_PER_RUN) {
    log_('brain', `Capping this run at ${MAX_FILES_PER_RUN}; ` +
                  `${newFiles.length - MAX_FILES_PER_RUN} remain for next run.`);
  }

  let processed = 0, skipped = 0, failed = 0;
  for (const file of slice) {
    const name = file.getName();
    const mime = file.getMimeType();
    log_('brain', `── ${name} (${mime})`);
    try {
      const text = extractFileText_(file);
      if (!text || text.trim().length < 50) {
        log_('brain', `   SKIP: extracted text too short (${text ? text.length : 0} chars)`);
        skipped++;
        continue;
      }
      const meta = extractMetadata_(text, name);
      const id = BrainStore.add({
        category:    meta.category,
        source:      file.getId(),
        source_type: 'upload',
        title:       meta.title || name,
        summary:     meta.summary,
        key_points:  meta.key_points,
        raw_text:    text.slice(0, 2000),
      });
      log_('brain', `   OK   → ${id} (${meta.category})`);
      processed++;
    } catch (e) {
      log_('brain', `   FAIL: ${e.name || 'Error'}: ${String(e.message || e).slice(0, 200)}`);
      failed++;
    }
  }

  log_('brain', '');
  log_('brain', `Done. processed=${processed}, skipped=${skipped}, failed=${failed}`);
  return { processed, skipped, failed };
}

/**
 * Install a daily time trigger that runs refreshBrain at BRAIN_REFRESH_HOUR
 * (read from the Config sheet). Idempotent — replaces any existing trigger
 * for refreshBrain.
 */
function setupBrainNightlyTrigger() {
  // Clear existing triggers for this handler.
  const existing = ScriptApp.getProjectTriggers();
  for (const t of existing) {
    if (t.getHandlerFunction() === 'refreshBrain') {
      ScriptApp.deleteTrigger(t);
    }
  }
  const hourCfg = getConfig('BRAIN_REFRESH_HOUR', '3');
  const hour = Math.max(0, Math.min(23, parseInt(hourCfg, 10) || 3));
  ScriptApp.newTrigger('refreshBrain')
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .create();
  log_('brain', `Nightly trigger installed: refreshBrain at ${hour}:00 daily.`);
}

/* ===========================================================================
 * File walking
 * ========================================================================= */

function collectFiles_(folder) {
  // Top-level files only for Phase 4. Nested folders can come later.
  const out = [];
  const iter = folder.getFiles();
  while (iter.hasNext()) {
    const f = iter.next();
    // Skip the README we auto-create in setup.
    if (f.getName() === 'README.txt' && f.getMimeType() === MimeType.PLAIN_TEXT) continue;
    out.push(f);
  }
  return out;
}

/* ===========================================================================
 * Text extraction — dispatch on MIME type
 * ========================================================================= */

function extractFileText_(file) {
  const mime = file.getMimeType();
  if (mime === MimeType.PLAIN_TEXT || mime === 'text/markdown' || mime === 'text/x-markdown') {
    return file.getBlob().getDataAsString().slice(0, MAX_RAW_CHARS);
  }
  if (mime === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(file.getId()).getBody().getText().slice(0, MAX_RAW_CHARS);
  }
  if (mime === MimeType.GOOGLE_SHEETS) {
    return extractFromSheet_(file.getId()).slice(0, MAX_RAW_CHARS);
  }
  if (mime === 'application/pdf'
      || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || mime === 'application/msword') {
    return extractViaConversion_(file).slice(0, MAX_RAW_CHARS);
  }
  throw new Error(`Unsupported MIME type: ${mime}. Convert to .txt, .md, Google Doc, or PDF.`);
}

function extractFromSheet_(fileId) {
  const ss = SpreadsheetApp.openById(fileId);
  const parts = [];
  for (const sheet of ss.getSheets()) {
    parts.push('# ' + sheet.getName());
    const data = sheet.getDataRange().getValues();
    for (const row of data) {
      const line = row.map(v => String(v || '').trim()).filter(Boolean).join(' | ');
      if (line) parts.push(line);
    }
  }
  return parts.join('\n');
}

/**
 * Convert PDF/DOCX → temp Google Doc via Advanced Drive Service, extract text,
 * delete the temp. Requires Advanced Drive Service enabled (see header doc).
 */
function extractViaConversion_(file) {
  if (typeof Drive === 'undefined' || !Drive.Files || !Drive.Files.copy) {
    throw new Error(
      'Drive Advanced Service not enabled. Apps Script editor → click + next to ' +
      'Services → add "Drive API v2". Then re-run.'
    );
  }
  const blob = file.getBlob();
  // Drive.Files.copy with target mimeType auto-converts.
  const tempName = '__brain_tmp_' + file.getId() + '_' + Date.now();
  const tempDoc = Drive.Files.copy(
    { title: tempName, mimeType: MimeType.GOOGLE_DOCS },
    file.getId(),
    { convert: true, ocr: true, ocrLanguage: 'en' }
  );
  try {
    const text = DocumentApp.openById(tempDoc.id).getBody().getText();
    return text;
  } finally {
    try { DriveApp.getFileById(tempDoc.id).setTrashed(true); }
    catch (_e) { /* ignore cleanup failures */ }
  }
}

/* ===========================================================================
 * Metadata extraction via LLM
 * ========================================================================= */

function extractMetadata_(text, filename) {
  const categories = VALID.brain_categories.filter(c => c !== 'reddit_intel');
  // reddit_intel is reserved for the RedditHunter; user uploads can't use it.

  const filenameHint = inferCategoryFromFilename_(filename, categories);

  const systemPrompt =
    'You are a Brain Curator for a Google Ads strategy knowledge base. ' +
    'Given a document, extract structured metadata that future agents will ' +
    'use as strategic context. Output STRICT JSON with this EXACT shape:\n' +
    '{\n' +
    '  "category":   "one of the allowed values below",\n' +
    '  "title":      "short descriptive title, max 80 chars",\n' +
    '  "summary":    "2–3 sentences capturing the key insight, max 400 chars",\n' +
    '  "key_points": ["3 to 5 actionable bullet points, each max 200 chars"]\n' +
    '}\n\n' +
    'Allowed categories: ' + categories.join(', ') + '\n' +
    (filenameHint ? `Filename hints category="${filenameHint}". Use unless content strongly disagrees.\n` : '') +
    'Return ONLY the JSON object. No prose, no markdown fences.';

  const userPrompt =
    `Filename: ${filename}\n\n--- DOCUMENT TEXT (truncated) ---\n` +
    text.slice(0, MAX_SUMMARY_INPUT);

  const result = callLLM(systemPrompt, userPrompt, {
    label:       'brain_curator',
    temperature: 0.2,
    max_tokens:  800,
  });

  const j = result.json || {};
  return {
    category:   sanitizeCategory_(j.category, categories, filenameHint),
    title:      String(j.title || filename).slice(0, 200),
    summary:    String(j.summary || '').slice(0, 600),
    key_points: Array.isArray(j.key_points)
                  ? j.key_points.map(p => String(p).slice(0, 300)).filter(Boolean).slice(0, 5)
                  : [],
  };
}

function inferCategoryFromFilename_(name, allowed) {
  const lower = name.toLowerCase();
  // Direct token match in filename → use it.
  for (const c of allowed) {
    if (lower.includes(c)) return c;
  }
  // Keyword shortcuts.
  const aliases = {
    bidding:      ['troas', 'tcpa', 'bid_strategy', 'bid-strategy', 'smart-bidding'],
    keywords:     ['kw', 'keyword', 'negatives', 'match-type'],
    copy:         ['rsa', 'headline', 'ad-copy', 'messaging'],
    structure:    ['stag', 'alpha-beta', 'campaign-structure'],
    scaling:      ['scale', 'ramp', 'budget-ramp'],
    audience:     ['rlsa', 'customer-match', 'lookalike', 'audience'],
    competitive:  ['competitor', 'conquest', 'auction-insight'],
    landing_page: ['landing', 'cro', 'lp-'],
    pmax:         ['performance-max', 'pmax', 'asset-group'],
    brand:        ['voice', 'tone', 'positioning'],
  };
  for (const [cat, words] of Object.entries(aliases)) {
    if (!allowed.includes(cat)) continue;
    if (words.some(w => lower.includes(w))) return cat;
  }
  return null;
}

function sanitizeCategory_(raw, allowed, fallback) {
  const c = String(raw || '').toLowerCase().trim();
  if (allowed.includes(c)) return c;
  if (fallback && allowed.includes(fallback)) return fallback;
  return 'general';
}

/* ===========================================================================
 * MANUAL TEST — exercise extraction + LLM call on a fake in-memory document
 * without touching Drive. Confirms the LLM contract works.
 * ========================================================================= */
function testBrainCuratorExtract() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'BrainCurator extractMetadata_ test (no Drive)');
  log_('test', '═══════════════════════════════════════════');

  const sampleText =
    'Target ROAS bidding works best when you have at least 50 conversions per ' +
    '30 days at the campaign level. Start tROAS at 75% of your trailing 30-day ' +
    'ROAS to give the algorithm room to learn. Adjust the target by no more ' +
    'than 10–15% per week — larger jumps reset the smart-bidding learning phase ' +
    'and tank performance for several days. Segment branded vs non-brand into ' +
    'separate campaigns so brand keywords (much higher ROAS) do not skew the ' +
    'tROAS calculation for prospecting traffic.';
  const meta = extractMetadata_(sampleText, 'troas-playbook.md');

  log_('test', `category:   ${meta.category}`);
  log_('test', `title:      ${meta.title}`);
  log_('test', `summary:    ${meta.summary}`);
  log_('test', `key_points: (${meta.key_points.length} items)`);
  for (const p of meta.key_points) log_('test', `  - ${p}`);
  log_('test', '');
  log_('test', meta.category === 'bidding'
    ? '✅ Routed to "bidding" as expected.'
    : `⚠️  Category was "${meta.category}", expected "bidding". Check the prompt.`);
}

/**
 * Bigger test: actually scan the Drive folder. Run this once after dropping
 * 1–2 test files into the Ads Agent Brain folder.
 */
function testBrainCuratorRefresh() {
  const result = refreshBrain();
  log_('test', `Result: processed=${result.processed}, skipped=${result.skipped}, failed=${result.failed}`);
}
