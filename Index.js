const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const URL = 'https://ugcleaks.short-term.workers.dev/leaks';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ROLE_ID = '1545880166683906118';
const STATE_FILE = path.join(__dirname, 'last_seen.json');

function loadLastSeen() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.warn('Failed to parse state file, starting fresh.');
      return {};
    }
  }
  return {};
}

function saveLastSeen(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
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
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for likely containers to appear, but don't crash if none do
    await page
      .waitForSelector('div.relative, .group, article, [role="main"], main', {
        timeout: 15000
      })
      .catch(() => {});

    // Extract structured data with fallback strategies
    const items = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Try common card-like containers first
      const cardSelectors = [
        'div.relative',
        'article',
        '.card',
        '.post',
        'div[class*="card"]',
        'div[class*="rounded"]'
      ];
      let cards = [];
      for (const sel of cardSelectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length) break;
      }

      function normalizeText(el) {
        return (el && el.innerText) ? el.innerText.trim().replace(/\s{2,}/g, ' ') : '';
      }

      // Parse each card heuristically
      if (cards.length) {
        for (const card of cards) {
          const text = normalizeText(card);
          if (!text || text.length < 4) continue;
          // Skip duplicate titles/content
          if (seen.has(text)) continue;

          // Look for keywords
          const hasKeywords = /STOCK|METHOD|RELEASE|STATUS|BY /i.test(text);
          // Split into lines and try to guess fields
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          const title =
            lines.find(l => l.length > 3 && l.length < 80 && !/STOCK|METHOD|RELEASE|STATUS|INTO/i.test(l)) ||
            lines[0] ||
            text.slice(0, 60);

          const creatorLine = lines.find(l => /^by\s+/i.test(l)) || '';
          const stockMatch = text.match(/STOCK[:\s-]*([0-9,]+|Unlimited)/i);
          const methodMatch = text.match(/METHOD[:\s-]*([A-Z0-9\s\-]+)/i);
          const statusMatch = text.match(/(Available|Ended|in\s+[0-9smh]+)/i);

          const details = lines.slice(1).join(' | ') || text;

          const item = {
            title: title.trim(),
            creator: creatorLine.replace(/^by\s+/i, '').trim() || 'Unknown',
            stock: stockMatch ? stockMatch[1].trim() : 'Unknown',
            method: methodMatch ? methodMatch[1].trim() : 'Unknown',
            status: statusMatch ? statusMatch[1].trim() : 'Active',
            details: details
          };

          if (!seen.has(item.title)) {
            results.push(item);
            seen.add(item.title);
          }
        }
      }

      // Fallback: pick up notable headings or short paragraphs
      if (results.length === 0) {
        const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,span'));
        for (const el of candidates) {
          const txt = normalizeText(el);
          if (txt.length >= 5 && txt.length <= 80 && !seen.has(txt)) {
            results.push({
              title: txt,
              creator: "Waffle's UGC",
              stock: 'Check Page',
              method: 'Code Drop',
              status: 'Upcoming',
              details: 'Check stream or page for details.'
            });
            seen.add(txt);
          }
          if (results.length >= 25) break;
        }
      }

      return results;
    });

    return items;
  } catch (error) {
    console.error('Scraping error:', error?.message || error);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('Failed to close browser cleanly:', e?.message || e);
      }
    }
  }
}

async function sendDiscordWebhook(item) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('Discord Webhook URL not set in environment variables.');
    return;
  }

  const payload = {
    content: `<@&${ROLE_ID}> New UGC leak detected! 🚨`,
    embeds: [
      {
        title: `✨ ${item.title}`,
        description: `**Creator:** ${item.creator}\n\n**Instructions & Details:**\n${item.details}`,
        color: 0xff006e,
        fields: [
          { name: '📦 Stock', value: `${item.stock}`, inline: true },
          { name: '⚡ Method', value: `${item.method}`, inline: true },
          { name: '⏳ Status', value: `${item.status}`, inline: true }
        ],
        footer: { text: 'UGC Leaks Tracker • Auto-Notifier' },
        timestamp: new Date().toISOString()
      }
    ]
  };

  try {
    const res = await axios.post(DISCORD_WEBHOOK_URL, payload, { timeout: 15000 });
    console.log(`Successfully sent alert for: ${item.title} (status ${res.status})`);
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

  for (const item of items) {
    const itemKey = item.title;
    if (!lastSeen[itemKey]) {
      console.log(`New item found: ${itemKey}`);
      await sendDiscordWebhook(item);
      lastSeen[itemKey] = { time: Date.now(), status: item.status };
      saveLastSeen(lastSeen);
    } else {
      // optionally log updated statuses
      if (lastSeen[itemKey].status !== item.status) {
        console.log(`Status changed for ${itemKey}: ${lastSeen[itemKey].status} -> ${item.status}`);
        lastSeen[itemKey].status = item.status;
        saveLastSeen(lastSeen);
      }
    }
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
          
