require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const URL = 'https://ugcleaks.short-term.workers.dev/leaks';

// Provide these via environment variables
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ROLE_ID = process.env.ROLE_ID || '1545880166683906118';

// State file path (can override with STATE_FILE env var)
const STATE_FILE = process.env.STATE_FILE || path.resolve(process.cwd(), 'last_seen.json');

function truncate(str = '', max = 1024) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function loadLastSeen() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    console.error('Failed to load last-seen state:', e);
  }
  return {};
}

function atomicWriteFileSync(filePath, data) {
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('Failed to write state file atomically:', err);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
  }
}

function saveLastSeen(data) {
  try {
    atomicWriteFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

async function scrapeUgcLeaks() {
  console.log('Launching browser to check UGC leaks...');
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Wait for likely card container(s). Avoid generic 'div' which would resolve immediately.
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

    try {
      await page.waitForSelector('div.relative, .group, [class*="card"], article, .grid', {
        timeout: 15000
      });
    } catch (e) {
      // It's okay if the specific selector doesn't appear - we'll still attempt extraction
      console.warn('Primary selector did not appear within timeout; attempting best-effort extraction.');
    }

    const extracted = await page.evaluate(() => {
      const normalize = s => (s || '').replace(/\s+/g, ' ').trim();

      const results = [];
      const seen = new Set();

      const cardSelectors = ['div.relative', '.group', '[class*="card"]', 'article', '.grid'];
      let nodes = [];
      for (const sel of cardSelectors) {
        nodes = nodes.concat(Array.from(document.querySelectorAll(sel)));
      }
      // Deduplicate nodes
      nodes = Array.from(new Set(nodes));

      // Try to find cards containing keywords first
      nodes.forEach(node => {
        const text = normalize(node.innerText || '');
        if (!text) return;

        const hasKey = /STOCK|METHOD|RELEASE|STATUS|by\s/i.test(text);
        if (!hasKey) return;

        // attempt to extract title
        let title = '';
        // Prefer heading inside card
        const h = node.querySelector('h1, h2, h3, .title, .name, a');
        if (h && h.innerText) title = normalize(h.innerText);
        if (!title) {
          // fallback to first meaningful line
          const lines = text.split('\n').map(l => normalize(l)).filter(Boolean);
          title = lines.find(l => l.length >= 3 && l.length <= 100) || lines[0] || '';
        }
        const creatorEl = node.querySelector('a[role="link"], a[href*="/user"], .creator, .by');
        const creator = creatorEl ? normalize(creatorEl.innerText || creatorEl.textContent || '') : (text.match(/by\s+([^\n\r]+)/i) ? text.match(/by\s+([^\n\r]+)/i)[1].trim() : '');
        const stockMatch = text.match(/STOCK[:\s-]*([0-9,]+|Unlimited)/i);
        const methodMatch = text.match(/METHOD[:\s-]*([\w\s\-\+]+)/i);
        const statusMatch = text.match(/(Available|Ended|Upcoming|Active|in\s+\d+\s*(?:s|m|h))/i);
        const linkEl = node.querySelector('a[href]');
        const url = linkEl ? linkEl.href : null;

        const info = (text.split('\n').map(l => normalize(l)).filter(Boolean).slice(-2).join(' — ')) || '';

        if (title && !seen.has(title)) {
          seen.add(title);
          results.push({
            title,
            creator: creator || 'Unknown',
            stock: stockMatch ? stockMatch[1] : 'Unknown',
            method: methodMatch ? methodMatch[1].trim() : 'Unknown',
            status: statusMatch ? statusMatch[1].trim() : 'Active',
            details: info || 'No additional details.',
            url: url || null
          });
        }
      });

      // Fallback: if nothing found, collect headings and anchors
      if (results.length === 0) {
        const candidates = Array.from(document.querySelectorAll('h1, h2, h3, p, a'));
        candidates.forEach(el => {
          const txt = normalize(el.innerText || el.textContent || el.getAttribute('title') || '');
          if (!txt) return;
          if (txt.length < 4 || txt.length > 120) return;
          if (seen.has(txt)) return;
          seen.add(txt);
          const url = el.tagName.toLowerCase() === 'a' ? el.href : null;
          results.push({
            title: txt,
            creator: 'Waffle\'s UGC',
            stock: 'Check Page',
            method: 'Code Drop',
            status: 'Upcoming',
            details: 'Check stream or page for details.',
            url
          });
        });
      }

      return results;
    });

    return extracted || [];
  } catch (error) {
    console.error('Scraping error:', error);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // ignore close errors
      }
    }
  }
}

async function sendDiscordWebhook(item) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('Discord Webhook URL not set in environment variables. Skipping webhook send.');
    return;
  }

  // Ensure we don't exceed Discord limits
  const title = truncate(item.title || 'New leak', 256);
  const description = truncate(
    `**Creator:** ${item.creator || 'Unknown'}\n\n**Instructions & Details:**\n${item.details || 'No details.'}${item.url ? `\n\nLink: ${item.url}` : ''}`,
    4096
  );

  const fields = [
    { name: '📦 Stock', value: `\`${truncate(String(item.stock || 'Unknown'), 1024)}\``, inline: true },
    { name: '⚡ Method', value: `\`${truncate(String(item.method || 'Unknown'), 1024)}\``, inline: true },
    { name: '⏳ Status', value: `\`${truncate(String(item.status || 'Unknown'), 1024)}\``, inline: true }
  ];

  const payload = {
    content: ROLE_ID ? `<@&${ROLE_ID}> New UGC leak detected! 🚨` : 'New UGC leak detected! 🚨',
    allowed_mentions: ROLE_ID ? { roles: [ROLE_ID] } : { parse: [] },
    embeds: [
      {
        title,
        description,
        color: 0xff006e,
        fields,
        footer: { text: 'UGC Leaks Tracker • Auto-Notifier' },
        timestamp: new Date().toISOString()
      }
    ]
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`Successfully sent alert for: ${item.title}`);
  } catch (err) {
    console.error('Failed to send Discord webhook:', err.response?.data || err.message || err);
  }
}

async function run() {
  const lastSeen = loadLastSeen();
  const items = await scrapeUgcLeaks();

  if (!items || items.length === 0) {
    console.log('No items detected during this execution cycle.');
    return;
  }

  let changed = false;

  for (const item of items) {
    // Use a more robust key: title + maybe creator or url
    const keyParts = [item.title || '', item.creator || '', item.url || ''];
    const itemKey = keyParts.filter(Boolean).join(' | ').slice(0, 200);

    if (!lastSeen[itemKey]) {
      console.log(`New item found: ${itemKey}`);
      await sendDiscordWebhook(item);
      lastSeen[itemKey] = { time: Date.now(), status: item.status || 'Unknown' };
      changed = true;
    } else {
      // Optionally update status if changed
      if (lastSeen[itemKey].status !== item.status) {
        console.log(`Status change for ${itemKey}: ${lastSeen[itemKey].status} -> ${item.status}`);
        lastSeen[itemKey].status = item.status;
        lastSeen[itemKey].time = Date.now();
        changed = true;
      }
    }
  }

  if (changed) saveLastSeen(lastSeen);
}

// Basic process-level handlers
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection at:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// Run immediately
run().catch(err => {
  console.error('Fatal error in run:', err);
});
