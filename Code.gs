// ===== Business Card Folder Scanner (AI-Powered) — v2 =====
//
// SETUP
//   1. Get a Gemini API key from Google AI Studio (https://aistudio.google.com/).
//   2. Open this project in the Apps Script editor (ideally from a Google Sheet:
//      Extensions → Apps Script). If the project is standalone, a results
//      spreadsheet is created automatically in your Drive on first scan.
//   3. Deploy → New deployment → Web app
//        Execute as:     Me
//        Who has access: Only myself      <-- IMPORTANT (see SECURITY below)
//   4. Open the web app URL, paste your Drive folder link + API key, scan.
//
// SECURITY
//   The app runs with YOUR Drive/Sheets/API-key permissions. If "Who has access"
//   is set to "Anyone", every visitor could read your folder and spend your
//   Gemini quota. v2 adds an owner check (assertOwner_) as a second line of
//   defence, but "Only myself" is the correct deployment setting.

// ---------- Configuration ----------
const SHEET_NAME = 'Cards';
const PROCESSED_SUBFOLDER_NAME = 'Processed';
const PROP_FOLDER_ID = 'CARD_SCANNER_FOLDER_ID';
const PROP_GEMINI_KEY = 'CARD_SCANNER_GEMINI_KEY';
const PROP_SHEET_ID = 'CARD_SCANNER_SHEET_ID';
const LOCK_WAIT_MS = 30000;

// The first model is preferred. If it is overloaded (503/500), rate limited (429)
// or unavailable (404), the next one is tried automatically.
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Formats Gemini can read. (GIF, BMP, TIFF, SVG are NOT supported.)
const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXT_TO_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const MAX_IMAGE_BYTES = 14 * 1024 * 1024; // Gemini inline request limit is ~20 MB after base64

// Sheet columns. Existing sheets keep their order; missing columns are appended.
const COL = {
  SERIAL: 'Serial No', NAME: 'Name', DESIGNATION: 'Designation', COMPANY: 'Company',
  PHONE: 'Phone', EMAIL: 'Email', WEBSITE: 'Website', ADDRESS: 'Address',
  STATUS: 'Status', NOTES: 'Notes', SOURCE: 'Source File', LINK: 'Card Image Link', SCANNED: 'Scanned At'
};
const COLUMNS = [COL.SERIAL, COL.NAME, COL.DESIGNATION, COL.COMPANY, COL.PHONE, COL.EMAIL, COL.WEBSITE,
  COL.ADDRESS, COL.STATUS, COL.NOTES, COL.SOURCE, COL.LINK, COL.SCANNED];

const STATUS_LABEL = { ok: 'OK', review: 'Check', duplicate: 'Possible duplicate' };
const STATUS_COLOR = { ok: '#e1f4e9', review: '#fff1d6', duplicate: '#fde8e6' };

// ---------- Web app entry ----------
function doGet() {
  try {
    assertOwner_();
  } catch (e) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:24px">Access denied. This scanner is private to its owner.</p>'
    ).setTitle('Card Scanner');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Card Scanner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Only the script owner may call the server functions. */
function assertOwner_() {
  const active = Session.getActiveUser().getEmail();
  const effective = Session.getEffectiveUser().getEmail();
  if (!active || !effective || active.toLowerCase() !== effective.toLowerCase()) {
    throw new Error('Access denied.');
  }
}

// ---------- Settings ----------
function extractFolderId_(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (!s) return '';
  let m = s.match(/folders\/([-\w]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([-\w]{10,})/);
  if (m) return m[1];
  m = s.match(/^[-\w]{10,}$/);
  return m ? m[0] : '';
}

function getSavedFolderId_() {
  const id = PropertiesService.getUserProperties().getProperty(PROP_FOLDER_ID);
  if (!id) throw new Error('No folder connected. Open setup and connect a folder.');
  return id;
}

/** Returns saved settings on page load. */
function getSavedSettings() {
  assertOwner_();
  const props = PropertiesService.getUserProperties();
  const folderId = props.getProperty(PROP_FOLDER_ID) || '';
  const hasApiKey = !!props.getProperty(PROP_GEMINI_KEY);
  if (!folderId) return { folderId: '', folderName: '', folderUrl: '', hasApiKey: hasApiKey };

  try {
    const folder = DriveApp.getFolderById(folderId);
    const preview = countPendingImages_(folder);
    return {
      folderId: folderId,
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      hasApiKey: hasApiKey,
      pendingCount: preview.pendingCount,
      skipped: preview.skipped
    };
  } catch (e) {
    // Do not delete the saved ID: the failure may be temporary.
    return { folderId: '', folderName: '', folderUrl: '', hasApiKey: hasApiKey, folderError: true };
  }
}

/** Validates and saves settings. A blank apiKey keeps the one already saved. */
function saveSettings(folderInput, apiKeyInput) {
  assertOwner_();
  const folderId = extractFolderId_(folderInput);
  if (!folderId) throw new Error('Paste the full Google Drive folder link.');

  const props = PropertiesService.getUserProperties();
  const newKey = String(apiKeyInput || '').trim();
  const apiKey = newKey || props.getProperty(PROP_GEMINI_KEY) || '';
  if (!apiKey) throw new Error('Enter your Gemini API key.');

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
    folder.getName();
  } catch (e) {
    throw new Error("Couldn't open that folder. Check the link and make sure it is in your Drive or shared with you.");
  }

  if (newKey) verifyApiKey_(newKey);

  props.setProperty(PROP_FOLDER_ID, folderId);
  props.setProperty(PROP_GEMINI_KEY, apiKey);

  const preview = countPendingImages_(folder);
  return {
    folderId: folderId,
    folderName: folder.getName(),
    folderUrl: folder.getUrl(),
    hasApiKey: true,
    pendingCount: preview.pendingCount,
    skipped: preview.skipped
  };
}

/** Cheap call that catches a wrong/expired key at setup time instead of mid-scan. */
function verifyApiKey_(key) {
  let code;
  try {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      method: 'get',
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true
    });
    code = res.getResponseCode();
  } catch (e) {
    return; // Network hiccup: don't block setup, the scan will surface real problems.
  }
  if (code === 400 || code === 401 || code === 403) {
    throw new Error('Gemini rejected this API key. Copy it again from Google AI Studio.');
  }
}

// ---------- Folder listing ----------
function detectMime_(file) {
  const mime = String(file.getMimeType() || '').toLowerCase();
  if (SUPPORTED_MIME.indexOf(mime) !== -1) return mime;
  // Some uploads arrive as application/octet-stream; fall back to the extension.
  if (mime === 'application/octet-stream' || mime === '') {
    const ext = (file.getName().split('.').pop() || '').toLowerCase();
    return EXT_TO_MIME[ext] || '';
  }
  return '';
}

function countPendingImages_(folder) {
  const files = folder.getFiles();
  let pendingCount = 0;
  let skipped = 0;
  while (files.hasNext()) {
    if (detectMime_(files.next())) pendingCount++; else skipped++;
  }
  return { pendingCount: pendingCount, skipped: skipped };
}

function refreshPendingCount() {
  assertOwner_();
  try {
    return countPendingImages_(DriveApp.getFolderById(getSavedFolderId_()));
  } catch (e) {
    throw new Error("Couldn't reach the folder. It may have been moved, renamed or unshared.");
  }
}

function getPendingFiles() {
  assertOwner_();
  let folder;
  try {
    folder = DriveApp.getFolderById(getSavedFolderId_());
  } catch (e) {
    throw new Error("Couldn't open the folder. It may have been moved, renamed or unshared.");
  }
  const files = folder.getFiles();
  const pending = [];
  let skipped = 0;
  while (files.hasNext()) {
    const file = files.next();
    if (detectMime_(file)) pending.push({ id: file.getId(), name: file.getName() });
    else skipped++;
  }
  pending.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  return { pending: pending, skipped: skipped };
}

// ---------- Processing ----------
const BATCH_BYTES_BUDGET = 24 * 1024 * 1024; // keep server memory safe when several original photos load at once
const MAX_BATCH = 6;
const THUMB_URL = 'https://drive.google.com/thumbnail?id=';
const THUMB_WIDTH = 1600;
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files/';

/**
 * FAST PATH (v3). Every slow step now runs for the whole batch IN PARALLEL with UrlFetchApp.fetchAll:
 *   1) file info for all cards        (Drive REST, 1 round trip  - was 4-5 sequential DriveApp calls per card)
 *   2) resized photos for all cards   (thumbnail endpoint)
 *   2b) originals, only for cards with no usable thumbnail (parallel - was one-by-one getBlob)
 *   3) Gemini for all cards
 *   4) ONE sheet write, then ONE parallel "move to Processed" (was one DriveApp.moveTo per card)
 */
function processBatch(fileIds) {
  assertOwner_();
  const t0 = Date.now();
  const timing = { load: 0, ai: 0, write: 0 };
  const ids = (fileIds || []).slice(0, MAX_BATCH);
  const results = new Array(ids.length);

  let folderId, apiKey, auth;
  try {
    folderId = getSavedFolderId_();
    apiKey = PropertiesService.getUserProperties().getProperty(PROP_GEMINI_KEY);
    if (!apiKey) throw new Error('Missing Gemini API key. Open setup and add it.');
    auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  } catch (e) {
    return ids.map(function (id) { return failure_(String(id), e); });
  }

  // 1) File info for every card in one parallel call.
  let mark = Date.now();
  let metaResp;
  try {
    metaResp = UrlFetchApp.fetchAll(ids.map(function (id) {
      return {
        url: DRIVE_API + encodeURIComponent(id) + '?supportsAllDrives=true&fields=id,name,mimeType,parents,webViewLink,size',
        headers: auth, muteHttpExceptions: true
      };
    }));
  } catch (e) {
    return ids.map(function (id) { return failure_(String(id), e); });
  }

  const cands = [];
  ids.forEach(function (id, i) {
    let name = String(id);
    try {
      const r = metaResp[i];
      if (r.getResponseCode() !== 200) throw new Error("Couldn't read this file from Drive.");
      const m = JSON.parse(r.getContentText());
      name = m.name || name;
      if ((m.parents || []).indexOf(folderId) === -1) throw new Error('This file is not in the connected folder.');
      const mime = detectMimeFromMeta_(m.name, m.mimeType);
      if (!mime) throw new Error('Unsupported format. Use JPG, PNG, WebP or HEIC.');
      cands.push({ i: i, id: id, name: name, url: m.webViewLink || '', size: Number(m.size) || 0, mime: mime });
    } catch (e) {
      results[i] = failure_(name, e);
    }
  });

  // 2) Small resized copies of all photos at once.
  let thumbs = [];
  if (cands.length) {
    try {
      thumbs = UrlFetchApp.fetchAll(cands.map(function (cd) {
        return {
          url: THUMB_URL + encodeURIComponent(cd.id) + '&sz=w' + THUMB_WIDTH,
          headers: auth, muteHttpExceptions: true
        };
      }));
    } catch (e) {
      thumbs = [];
    }
  }

  const needOriginal = [];
  cands.forEach(function (cd, k) {
    const t = thumbs[k];
    if (t && t.getResponseCode() === 200) {
      const ct = headerValue_(t.getHeaders(), 'content-type').split(';')[0].trim().toLowerCase();
      const content = t.getContent();
      if (SUPPORTED_MIME.indexOf(ct) !== -1 && content.length > 2000) { cd.bytes = content; cd.mime = ct; return; }
    }
    needOriginal.push(cd);
  });

  // 2b) Originals (only when there was no usable thumbnail), downloaded in parallel.
  const toDownload = [];
  let budget = 0;
  needOriginal.forEach(function (cd) {
    if (cd.size > MAX_IMAGE_BYTES) { results[cd.i] = failure_(cd.name, new Error('Image is larger than 14 MB. Re-save it smaller and try again.')); return; }
    if (toDownload.length && budget + cd.size > BATCH_BYTES_BUDGET) { results[cd.i] = { success: false, name: cd.name, deferred: true, error: 'Deferred' }; return; }
    budget += cd.size;
    toDownload.push(cd);
  });
  if (toDownload.length) {
    let dl = [];
    try {
      dl = UrlFetchApp.fetchAll(toDownload.map(function (cd) {
        return { url: DRIVE_API + encodeURIComponent(cd.id) + '?alt=media&supportsAllDrives=true', headers: auth, muteHttpExceptions: true };
      }));
    } catch (e) { dl = []; }
    toDownload.forEach(function (cd, k) {
      if (dl[k] && dl[k].getResponseCode() === 200) cd.bytes = dl[k].getContent();
      else results[cd.i] = failure_(cd.name, new Error('Could not download this photo.'));
    });
  }

  const prepared = cands.filter(function (cd) { return cd.bytes && !results[cd.i]; });
  timing.load = Date.now() - mark;

  // 3) Send all images to Gemini at the same time.
  mark = Date.now();
  let fast = [];
  if (prepared.length) {
    try {
      const useThinking = !noThinking_();
      const url = GEMINI_BASE + GEMINI_MODELS[0] + ':generateContent';
      fast = UrlFetchApp.fetchAll(prepared.map(function (p) {
        return {
          url: url, method: 'post', contentType: 'application/json',
          headers: { 'x-goog-api-key': apiKey },
          payload: buildGeminiBody_(Utilities.base64Encode(p.bytes), p.mime, useThinking),
          muteHttpExceptions: true
        };
      })).map(function (r) { return { code: r.getResponseCode(), text: r.getContentText() }; });
    } catch (e) {
      fast = [];
    }
  }

  // Parse. Anything that failed gets the patient path (retries + backup models).
  // Failed cards are retried IN PARALLEL on the backup model instead of one after another.
  const extracted = [];
  const retryList = [];
  prepared.forEach(function (p, k) {
    const r = fast[k];
    let raw = null;
    if (r && r.code === 200) { try { raw = parseGeminiResponse_(r.text); } catch (parseErr) { raw = null; } }
    if (raw) extracted.push({ p: p, card: normalizeCard_(raw) });
    else retryList.push(p);
  });
  retryList.forEach(function (p) {
    try {
      if (Date.now() - t0 > 150000) { // stay well inside the 6-minute Apps Script limit
        const slow = new Error('Gemini is taking too long right now.'); slow.rateLimited = true; throw slow;
      }
      extracted.push({ p: p, card: normalizeCard_(extractCardWithGemini_(p.bytes, p.mime, apiKey)) });
    } catch (e) {
      results[p.i] = failure_(p.name, e);
    }
  });
  timing.ai = Date.now() - mark;

  // 4) One sheet write, then one parallel move to Processed.
  mark = Date.now();
  if (extracted.length) {
    let saved = null;
    try {
      saved = appendCardRows_(extracted.map(function (x) { return { card: x.card, name: x.p.name, url: x.p.url }; }));
    } catch (e) {
      extracted.forEach(function (x) { results[x.p.i] = failure_(x.p.name, e); });
    }
    if (saved) {
      let moveOk = extracted.map(function () { return false; });
      try {
        const procId = getProcessedFolderId_(folderId);
        const moves = UrlFetchApp.fetchAll(extracted.map(function (x) {
          return {
            url: DRIVE_API + encodeURIComponent(x.p.id) + '?supportsAllDrives=true&fields=id&addParents=' +
                 encodeURIComponent(procId) + '&removeParents=' + encodeURIComponent(folderId),
            method: 'patch', contentType: 'application/json', payload: '{}',
            headers: auth, muteHttpExceptions: true
          };
        }));
        moveOk = moves.map(function (m) { return m.getResponseCode() === 200; });
      } catch (e) { /* handled below */ }
      if (moveOk.indexOf(false) !== -1) clearProcessedFolderCache_(folderId);

      extracted.forEach(function (x, k) {
        const s = saved[k];
        if (!moveOk[k]) {
          s.issues.push('Saved, but the image could not be moved to Processed.');
          if (s.status === 'ok') s.status = 'review';
        }
        results[x.p.i] = { success: true, name: x.p.name, card: x.card.fields, status: s.status, issues: s.issues, row: s.row };
      });
    }
  }
  timing.write = Date.now() - mark;

  results.forEach(function (r) { if (r) r.timing = timing; });
  return results;
}

function detectMimeFromMeta_(name, mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (SUPPORTED_MIME.indexOf(mime) !== -1) return mime;
  if (mime === 'application/octet-stream' || mime === '') {
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    return EXT_TO_MIME[ext] || '';
  }
  return '';
}

/** The Processed folder id is remembered for 6 hours so we don't search Drive for it on every batch. */
function getProcessedFolderId_(parentId) {
  const cache = CacheService.getScriptCache();
  const key = 'PROC_' + parentId;
  try { const c = cache.get(key); if (c) return c; } catch (e) { /* ignore */ }
  const id = getOrCreateSubfolder_(DriveApp.getFolderById(parentId), PROCESSED_SUBFOLDER_NAME).getId();
  try { cache.put(key, id, 21600); } catch (e) { /* ignore */ }
  return id;
}
function clearProcessedFolderCache_(parentId) {
  try { CacheService.getScriptCache().remove('PROC_' + parentId); } catch (e) { /* ignore */ }
}

function headerValue_(headers, key) {
  for (const k in headers) { if (k.toLowerCase() === key) return String(headers[k]); }
  return '';
}

/** Kept for compatibility: a batch of one. */
function processOneFile(fileId) {
  return processBatch([fileId])[0];
}

function failure_(name, e) {
  return { success: false, name: name, error: errMessage_(e), rateLimited: !!(e && e.rateLimited), retryAfter: 20 };
}

function isDirectChild_(file, folder) {
  const parents = file.getParents();
  const folderId = folder.getId();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

// ---------- Gemini ----------
const CARD_PROMPT = [
  'You are an expert at reading business cards from photos.',
  'The photo may be rotated, tilted, dim, glossy, cropped, or contain several languages (for example English and Bangla).',
  'Extract ONLY what is actually printed on the card.',
  '',
  'Rules:',
  '- Copy text exactly as printed. Never guess, complete, or invent anything. If a field is missing or unreadable, return "" (or an empty list).',
  '- name: the person\'s full name, not the company. Keep honorifics such as Dr., Engr., Md. as printed. If the name appears in both English and another script, return the English version.',
  '- designation: the job title or position.',
  '- company: the organisation name.',
  '- phones: every phone, mobile or WhatsApp number of the person or office. List mobile numbers first. Keep the country code and formatting as printed. Convert any non-Latin digits (for example Bangla ০১৭) to 0-9. Do NOT include fax numbers.',
  '- emails: every email address, in lowercase.',
  '- website: the website address, if printed.',
  '- address: the postal address on a single line, if printed.',
  '- If several people appear, use the most prominent one.',
  '- is_business_card: false only if the image is clearly not a business card.'
].join('\n');

const CARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_business_card: { type: 'BOOLEAN' },
    name: { type: 'STRING' },
    designation: { type: 'STRING' },
    company: { type: 'STRING' },
    phones: { type: 'ARRAY', items: { type: 'STRING' } },
    emails: { type: 'ARRAY', items: { type: 'STRING' } },
    website: { type: 'STRING' },
    address: { type: 'STRING' }
  },
  required: ['is_business_card', 'name', 'designation', 'company', 'phones', 'emails', 'website', 'address']
};

/** True when a previous call showed the model rejects the thinking setting (cached 6h). */
function noThinking_() {
  try { return !!CacheService.getScriptCache().get('NO_THINKING'); } catch (e) { return false; }
}
function markNoThinking_() {
  try { CacheService.getScriptCache().put('NO_THINKING', '1', 21600); } catch (e) { /* ignore */ }
}

/**
 * Card reading is simple, so "low" thinking is enough and is noticeably faster than
 * the default. If a model rejects the setting we retry without it (and remember that).
 */
function buildGeminiBody_(base64, mimeType, useThinking) {
  const gc = { responseMimeType: 'application/json', responseSchema: CARD_SCHEMA };
  if (useThinking) gc.thinkingConfig = { thinkingLevel: 'low' };
  return JSON.stringify({
    contents: [{ parts: [{ text: CARD_PROMPT }, { inlineData: { mimeType: mimeType, data: base64 } }] }],
    generationConfig: gc
  });
}

/** Patient single-card path: retries, then backup models. */
function extractCardWithGemini_(bytes, mimeType, apiKey) {
  const base64 = Utilities.base64Encode(bytes);
  let useThinking = !noThinking_();

  let res = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const url = GEMINI_BASE + GEMINI_MODELS[i] + ':generateContent';
    res = fetchGeminiWithRetry_(url, buildGeminiBody_(base64, mimeType, useThinking), apiKey);
    if (useThinking && res.code === 400 && /thinking/i.test(res.text)) {
      useThinking = false;
      markNoThinking_();
      res = fetchGeminiWithRetry_(url, buildGeminiBody_(base64, mimeType, false), apiKey);
    }
    const switchModel = res.code === 0 || res.code === 404 || res.code === 429 || res.code >= 500;
    if (switchModel && i < GEMINI_MODELS.length - 1) continue; // try the next model
    break;
  }

  if (res.code !== 200) throw geminiError_(res);
  return parseGeminiResponse_(res.text);
}

/** POST with exponential backoff on rate limits, server errors and network failures. */
function fetchGeminiWithRetry_(url, payload, apiKey) {
  const maxAttempts = 2; // short per model: after this we switch to the next model
  let last = { code: 0, text: '' };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const r = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey }, // header, not URL: keeps the key out of logs
        payload: payload,
        muteHttpExceptions: true
      });
      last = { code: r.getResponseCode(), text: r.getContentText() };
    } catch (netErr) {
      last = { code: 0, text: String(netErr) };
    }
    const retryable = last.code === 0 || last.code === 429 || last.code >= 500;
    if (!retryable || attempt === maxAttempts - 1) break;
    Utilities.sleep(3000 + Math.floor(Math.random() * 1500)); // brief pause, then retry once
  }
  return last;
}

function geminiError_(res) {
  let apiMsg = '';
  try { apiMsg = JSON.parse(res.text).error.message || ''; } catch (e) { /* not JSON */ }

  let msg;
  let rateLimited = false;
  if (res.code === 0) { msg = 'Could not reach Gemini (network problem).'; rateLimited = true; }
  else if (res.code === 429) { msg = 'Gemini rate limit reached (free-tier quota or requests per minute).'; rateLimited = true; }
  else if (res.code >= 500) { msg = 'Gemini is overloaded right now. This is temporary.'; rateLimited = true; }
  else if (res.code === 400 && /api key/i.test(apiMsg)) msg = 'Your Gemini API key was rejected. Update it in setup.';
  else if (res.code === 401 || res.code === 403) msg = 'Gemini denied access. Check that your API key is valid and enabled.';
  else if (res.code === 404) msg = 'The Gemini model is not available for this key.';
  else msg = 'Gemini error (' + res.code + '): ' + apiMsg.substring(0, 160);

  const err = new Error(msg);
  err.rateLimited = rateLimited;
  return err;
}

function parseGeminiResponse_(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Gemini returned an unreadable response.'); }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error('Gemini declined to read this image (' + data.promptFeedback.blockReason + ').');
  }
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!parts || !parts.length) {
    throw new Error('Gemini returned no result' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.');
  }
  const out = parts.filter(function (p) { return !p.thought && typeof p.text === 'string'; })
    .map(function (p) { return p.text; }).join('');
  try {
    return JSON.parse(out.replace(/```json|```/g, '').trim());
  } catch (e) {
    throw new Error('Gemini returned data in an unexpected format.');
  }
}

// ---------- Cleaning and validation ----------
function collapse_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function toLatinDigits_(s) {
  return String(s)
    .replace(/[\u09E6-\u09EF]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0x09E6 + 48); }) // Bangla
    .replace(/[\u0660-\u0669]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48); }); // Arabic-Indic
}

function normalizeCard_(raw) {
  raw = raw || {};
  const issues = [];

  const name = collapse_(raw.name);
  const designation = collapse_(raw.designation);
  const company = collapse_(raw.company);
  const address = collapse_(raw.address);

  let website = collapse_(raw.website).replace(/\s/g, '').toLowerCase();
  if (website.indexOf('@') !== -1) website = '';

  const emails = [];
  (Array.isArray(raw.emails) ? raw.emails : []).forEach(function (e) {
    const v = collapse_(e).replace(/^mailto:/i, '').replace(/\s/g, '').toLowerCase();
    if (!v) return;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
      if (emails.indexOf(v) === -1) emails.push(v);
    } else {
      issues.push('Email looks wrong: ' + v);
    }
  });

  const phones = [];
  (Array.isArray(raw.phones) ? raw.phones : []).forEach(function (p) {
    const v = collapse_(toLatinDigits_(p)).replace(/[^\d+()\-.\s\/]/g, '').trim();
    const digits = v.replace(/\D/g, '');
    if (!digits) return;
    if (digits.length < 7 || digits.length > 15) issues.push('Phone may be incomplete: ' + v);
    if (phones.indexOf(v) === -1) phones.push(v);
  });

  if (raw.is_business_card === false) issues.push('This image may not be a business card.');
  if (!name) issues.push('Name not found.');
  if (!emails.length && !phones.length) issues.push('No phone or email found.');

  return {
    fields: {
      name: name, designation: designation, company: company,
      phone: phones.join(', '), email: emails.join(', '),
      website: website, address: address
    },
    issues: issues
  };
}

// ---------- Sheet ----------
function getSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  // Standalone script: reuse or create a results spreadsheet.
  const props = PropertiesService.getUserProperties();
  const savedId = props.getProperty(PROP_SHEET_ID);
  if (savedId) {
    try { return SpreadsheetApp.openById(savedId); } catch (e) { /* deleted: create a new one */ }
  }
  const ss = SpreadsheetApp.create('Business Card Scanner - Results');
  props.setProperty(PROP_SHEET_ID, ss.getId());
  return ss;
}

function getOrCreateSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    const sheets = ss.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheet = sheets[0];
      sheet.setName(SHEET_NAME);
    } else {
      sheet = ss.insertSheet(SHEET_NAME);
    }
  }
  return sheet;
}

/** Makes sure every expected column exists. Returns the header list in sheet order. */
function ensureHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  let headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];

  if (!headers.some(function (h) { return h; })) {
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return COLUMNS.slice();
  }

  const missing = COLUMNS.filter(function (c) { return headers.indexOf(c) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    headers = headers.concat(missing);
  }
  sheet.setFrozenRows(1);
  return headers;
}

function emailKeys_(cell) {
  return String(cell || '').toLowerCase().split(/[,\s;|]+/).filter(function (x) { return x.indexOf('@') > 0; });
}
function phoneKeys_(cell) {
  return String(cell || '').split(',').map(function (p) { return toLatinDigits_(p).replace(/\D/g, ''); })
    .filter(function (d) { return d.length >= 7; })
    .map(function (d) { return d.slice(-10); }); // compare on the last 10 digits, ignoring country code
}

/**
 * Appends several rows in ONE write, inside a lock. Returns [{ row, status, issues }]
 * in the same order. Duplicates are checked against existing rows AND earlier cards in the batch.
 */
function appendCardRows_(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    const sheet = getOrCreateSheet_();
    const headers = ensureHeaders_(sheet);
    const idx = function (name) { return headers.indexOf(name); };

    // Read existing rows once: next serial number + lookup tables for duplicates.
    const lastRow = sheet.getLastRow();
    let maxSerial = 0;
    const emailRow = {};
    const phoneRow = {};
    if (lastRow > 1) {
      const data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      for (let i = 0; i < data.length; i++) {
        const serial = Number(data[i][idx(COL.SERIAL)]);
        if (serial > maxSerial) maxSerial = serial;
        if (idx(COL.EMAIL) !== -1) emailKeys_(data[i][idx(COL.EMAIL)]).forEach(function (k) { if (!emailRow[k]) emailRow[k] = i + 2; });
        if (idx(COL.PHONE) !== -1) phoneKeys_(data[i][idx(COL.PHONE)]).forEach(function (k) { if (!phoneRow[k]) phoneRow[k] = i + 2; });
      }
    }

    const startRow = lastRow + 1;
    const out = [];
    const rows = [];
    const backgrounds = [];
    const formats = headers.map(function (h) {
      if (h === COL.SERIAL) return '0';
      if (h === COL.SCANNED) return 'yyyy-mm-dd hh:mm';
      return '@'; // plain text: keeps "+8801712…" intact and stops "=…" becoming a formula
    });

    items.forEach(function (item, k) {
      const f = item.card.fields;
      const rowNumber = startRow + k;
      const eKeys = emailKeys_(f.email);
      const pKeys = phoneKeys_(f.phone);

      let dupRow = 0;
      eKeys.forEach(function (x) { if (!dupRow && emailRow[x]) dupRow = emailRow[x]; });
      pKeys.forEach(function (x) { if (!dupRow && phoneRow[x]) dupRow = phoneRow[x]; });
      eKeys.forEach(function (x) { if (!emailRow[x]) emailRow[x] = rowNumber; });
      pKeys.forEach(function (x) { if (!phoneRow[x]) phoneRow[x] = rowNumber; });

      const issues = item.card.issues.slice();
      let status = issues.length ? 'review' : 'ok';
      if (dupRow) {
        status = 'duplicate';
        issues.push('Same email or phone as row ' + dupRow + '.');
      }

      const values = {};
      values[COL.SERIAL] = maxSerial + 1 + k;
      values[COL.NAME] = f.name;
      values[COL.DESIGNATION] = f.designation;
      values[COL.COMPANY] = f.company;
      values[COL.PHONE] = f.phone;
      values[COL.EMAIL] = f.email;
      values[COL.WEBSITE] = f.website;
      values[COL.ADDRESS] = f.address;
      values[COL.STATUS] = STATUS_LABEL[status];
      values[COL.NOTES] = issues.join(' ');
      values[COL.SOURCE] = item.name;
      values[COL.LINK] = item.url;
      values[COL.SCANNED] = new Date();

      rows.push(headers.map(function (h) { return values.hasOwnProperty(h) ? values[h] : ''; }));
      backgrounds.push([STATUS_COLOR[status]]);
      out.push({ row: rowNumber, status: status, issues: issues });
    });

    const range = sheet.getRange(startRow, 1, rows.length, headers.length);
    range.setNumberFormats(rows.map(function () { return formats; }));
    range.setValues(rows);
    if (idx(COL.STATUS) !== -1) sheet.getRange(startRow, idx(COL.STATUS) + 1, rows.length, 1).setBackgrounds(backgrounds);
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

function getSheetUrl() {
  assertOwner_();
  const sheet = getOrCreateSheet_();
  return getSpreadsheet_().getUrl() + '#gid=' + sheet.getSheetId();
}

// ---------- Helpers ----------
function getOrCreateSubfolder_(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

function errMessage_(e) {
  return (e && e.message) ? e.message : String(e);
}