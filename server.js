const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { parse } = require('node-html-parser');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config ---
const PORT = 3002;
const DOCS_FILE = path.join(__dirname, 'docs.json');
const CACHE_DIR = path.join(__dirname, 'cache');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Ensure directories exist
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// --- File Upload Config ---
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.doc', '.txt', '.md', '.csv', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Allowed: ${allowed.join(', ')}`));
    }
  }
});

// --- Anthropic Client ---
let anthropic;
function getAnthropicClient() {
  if (!anthropic) {
    const apiKey = getSettings().apiKey;
    if (!apiKey) throw new Error('No Anthropic API key configured. Go to Settings to add your key.');
    anthropic = new Anthropic.default({ apiKey });
  }
  return anthropic;
}

// --- Settings ---
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function getSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
  return { apiKey: process.env.ANTHROPIC_API_KEY || '' };
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  anthropic = null;
}

// --- Document Management ---
function getDocs() {
  if (fs.existsSync(DOCS_FILE)) {
    return JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
  }
  return [];
}

function saveDocs(docs) {
  fs.writeFileSync(DOCS_FILE, JSON.stringify(docs, null, 2));
}

// --- File Text Extraction ---
async function extractFileText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return fs.readFileSync(filePath, 'utf8');
  }

  if (ext === '.json') {
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }

  if (ext === '.pdf') {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx' || ext === '.doc') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// --- Google Doc Fetcher ---
async function fetchGoogleDoc(url) {
  const cacheKey = Buffer.from(url).toString('base64').replace(/[/+=]/g, '_');
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.content;
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch doc: ${response.status}`);
  const html = await response.text();

  const root = parse(html);
  root.querySelectorAll('script, style').forEach(el => el.remove());

  const contentDiv = root.querySelector('.doc-content') || root.querySelector('#contents') || root.querySelector('body');
  let text = contentDiv ? extractHtmlText(contentDiv) : root.text;
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  fs.writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), content: text }));
  return text;
}

function extractHtmlText(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      text += child.text;
    } else if (child.nodeType === 1) {
      const tag = child.tagName?.toLowerCase();
      if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'li', 'tr'].includes(tag)) {
        text += '\n';
      }
      if (tag === 'li') text += '• ';
      text += extractHtmlText(child);
      if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr'].includes(tag)) {
        text += '\n';
      }
    }
  }
  return text;
}

async function fetchPlainDoc(url) {
  const cacheKey = Buffer.from(url).toString('base64').replace(/[/+=]/g, '_');
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.content;
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch doc: ${response.status}`);
  const text = await response.text();

  fs.writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), content: text }));
  return text;
}

// --- Build Knowledge Context ---
async function buildKnowledgeContext() {
  const docs = getDocs();
  if (docs.length === 0) return 'No documents have been added to the knowledge base yet.';

  const sections = [];
  for (const doc of docs) {
    try {
      let content;
      if (doc.type === 'upload') {
        // Read extracted text from stored content
        content = doc.extractedText || '[No text extracted]';
      } else if (doc.type === 'paste') {
        content = doc.content;
      } else if (doc.url && doc.url.includes('docs.google.com')) {
        content = await fetchGoogleDoc(doc.url);
      } else if (doc.url) {
        content = await fetchPlainDoc(doc.url);
      }
      sections.push(`=== DOCUMENT: ${doc.name} ===\n${content}\n=== END: ${doc.name} ===`);
    } catch (err) {
      sections.push(`=== DOCUMENT: ${doc.name} ===\n[Error loading document: ${err.message}]\n=== END: ${doc.name} ===`);
    }
  }

  return sections.join('\n\n');
}

// --- API Routes ---

// Settings
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json({ hasApiKey: !!settings.apiKey });
});

app.post('/api/settings', (req, res) => {
  const { apiKey } = req.body;
  saveSettings({ apiKey });
  res.json({ success: true });
});

// Documents CRUD
app.get('/api/docs', (req, res) => {
  // Don't send extractedText to frontend (can be huge)
  const docs = getDocs().map(d => ({
    ...d,
    extractedText: undefined,
    hasContent: !!(d.extractedText || d.content || d.url)
  }));
  res.json(docs);
});

// Add doc via URL or paste
app.post('/api/docs', (req, res) => {
  const { name, url, type, content } = req.body;
  const docs = getDocs();
  const doc = {
    id: Date.now().toString(),
    name,
    url: url || null,
    type: type || 'url',
    content: content || null,
    extractedText: null,
    addedAt: new Date().toISOString()
  };
  docs.push(doc);
  saveDocs(docs);

  if (doc.url) {
    const cacheKey = Buffer.from(doc.url).toString('base64').replace(/[/+=]/g, '_');
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
  }

  res.json({ ...doc, extractedText: undefined });
});

// Upload file
app.post('/api/docs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const name = req.body.name || req.file.originalname;
    const filePath = req.file.path;

    // Extract text from file
    const extractedText = await extractFileText(filePath, req.file.originalname);

    const docs = getDocs();
    const doc = {
      id: Date.now().toString(),
      name,
      type: 'upload',
      fileName: req.file.originalname,
      filePath: filePath,
      extractedText: extractedText,
      url: null,
      content: null,
      addedAt: new Date().toISOString()
    };
    docs.push(doc);
    saveDocs(docs);

    res.json({
      ...doc,
      extractedText: undefined,
      hasContent: true,
      textLength: extractedText.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-upload / update a file
app.post('/api/docs/:id/reupload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const docs = getDocs();
    const docIndex = docs.findIndex(d => d.id === req.params.id);
    if (docIndex === -1) return res.status(404).json({ error: 'Doc not found' });

    // Delete old file if it exists
    if (docs[docIndex].filePath && fs.existsSync(docs[docIndex].filePath)) {
      fs.unlinkSync(docs[docIndex].filePath);
    }

    const extractedText = await extractFileText(req.file.path, req.file.originalname);

    docs[docIndex] = {
      ...docs[docIndex],
      fileName: req.file.originalname,
      filePath: req.file.path,
      extractedText: extractedText,
      updatedAt: new Date().toISOString()
    };
    saveDocs(docs);

    res.json({ success: true, textLength: extractedText.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/docs/:id', (req, res) => {
  let docs = getDocs();
  const doc = docs.find(d => d.id === req.params.id);

  // Delete uploaded file if it exists
  if (doc && doc.filePath && fs.existsSync(doc.filePath)) {
    fs.unlinkSync(doc.filePath);
  }

  docs = docs.filter(d => d.id !== req.params.id);
  saveDocs(docs);
  res.json({ success: true });
});

// Refresh cache for a URL doc
app.post('/api/docs/:id/refresh', async (req, res) => {
  const docs = getDocs();
  const doc = docs.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Doc not found' });
  if (!doc.url) return res.json({ success: true, message: 'No URL to refresh' });

  const cacheKey = Buffer.from(doc.url).toString('base64').replace(/[/+=]/g, '_');
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
  if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);

  try {
    if (doc.url.includes('docs.google.com')) {
      await fetchGoogleDoc(doc.url);
    } else {
      await fetchPlainDoc(doc.url);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Knowledge base stats
app.get('/api/stats', async (req, res) => {
  try {
    const context = await buildKnowledgeContext();
    const charCount = context.length;
    const estimatedTokens = Math.ceil(charCount / 4);
    const docs = getDocs();
    res.json({
      documentCount: docs.length,
      totalCharacters: charCount,
      estimatedTokens,
      maxTokens: 180000
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat endpoint with streaming + prompt caching
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  try {
    const client = getAnthropicClient();
    const knowledgeContext = await buildKnowledgeContext();

    // Use structured system prompt with cache_control
    // The knowledge base documents get cached on Anthropic's servers after the first call.
    // Subsequent calls reuse the cache (~90% cheaper) as long as the docs haven't changed.
    const systemPrompt = [
      {
        type: 'text',
        text: `You are a helpful company knowledge base assistant. Your ONLY job is to answer questions based on the documents provided below.

CRITICAL RULES:
1. ONLY answer based on information found in the documents below. Never make up answers or use general knowledge.
2. If the answer is in the documents, quote or closely paraphrase the relevant section. Be direct — give the answer first.
3. If the answer is NOT in any document, say: "I don't have information about that in the current knowledge base."
4. When referencing information, mention which document it comes from.
5. Do NOT give generic advice. If the documents say something specific, use that exact information.
6. Keep answers concise and actionable.`
      },
      {
        type: 'text',
        text: `KNOWLEDGE BASE DOCUMENTS:\n${knowledgeContext}`,
        cache_control: { type: 'ephemeral' }
      }
    ];

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    // Log cache performance
    const finalMessage = await stream.finalMessage();
    const cacheRead = finalMessage.usage?.cache_read_input_tokens || 0;
    const cacheCreate = finalMessage.usage?.cache_creation_input_tokens || 0;
    const inputTokens = finalMessage.usage?.input_tokens || 0;
    if (cacheRead > 0) {
      console.log(`✅ Cache HIT — ${cacheRead} tokens read from cache (saved ~90% on those tokens)`);
    } else if (cacheCreate > 0) {
      console.log(`📦 Cache CREATED — ${cacheCreate} tokens cached for next requests`);
    }
    console.log(`   Total input: ${inputTokens} tokens | Output: ${finalMessage.usage?.output_tokens || 0} tokens`);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`\n🧠 Knowledge Base Widget running at http://localhost:${PORT}`);
  console.log(`   Add docs, upload files, and start chatting!\n`);
});
