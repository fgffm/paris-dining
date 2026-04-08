#!/usr/bin/env node
/**
 * Table & Métro — Cache Generator
 * Generates restaurant recommendations for every Paris arrondissement
 * and writes them to restaurants.json for the website to consume.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node generate-cache.js
 *
 * Or via npm script (add to package.json):
 *   "scripts": { "generate": "node generate-cache.js" }
 *
 * Recommended: run monthly via GitHub Actions (see generate-cache.yml)
 * Cost: ~20 arrondissements × ~800 tokens = ~16,000 tokens ≈ $0.01 with Haiku
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// Arrondissements to generate — can subset this for testing
const ARRONDISSEMENTS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20];

// Delay between API calls to avoid rate limits (ms)
const DELAY_MS = 8000;

// ── Anthropic API call ────────────────────────────────────
function callAnthropic(messages, system) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      system,
      messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`API ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 200)}`));
          } else {
            const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
            resolve(text);
          }
        } catch(e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Generate restaurants for one arrondissement ───────────
async function generateForArrondissement(arr) {
  const ordinal = arr === 1 ? '1er' : `${arr}ème`;

  const prompt = `You are a Paris dining expert with deep knowledge of Le Fooding, Omnivore, Falstaff, Eater Paris, Reddit r/paris, Google reviews and TripAdvisor.

Generate a curated list of the 6 best restaurants currently operating in the ${ordinal} arrondissement of Paris. Cover a range of price points and styles. Include only real, well-established restaurants.

For each restaurant include:
- Accurate GPS coordinates for the ${ordinal} arrondissement
- Realistic Google and guide scores based on your knowledge
- Specific pros and cons drawn from real diner feedback
- Honest budget estimates

RESPOND WITH ONLY A JSON ARRAY. No text before or after. No markdown. ASCII only in strings - no accented characters, no apostrophes.

[
  {
    "name": "Restaurant Name",
    "arrondissement": "${ordinal}",
    "arr_num": "${arr}",
    "neighbourhood": "string",
    "lat": 48.8566,
    "lng": 2.3522,
    "cuisine": "string",
    "budget_tier": "euro sign 1-4 e.g. 2 euros signs",
    "highlight": "string 4-6 words",
    "why": "2 sentences on what makes it special",
    "cuisine_tags": ["string","string","string"],
    "scores": [
      {"source": "Google", "score": "4.5", "count": "800 avis"},
      {"source": "Le Fooding", "score": "Recommande", "count": ""}
    ],
    "pros": ["string","string","string"],
    "cons": ["string","string","string"],
    "budget_reality": "string e.g. 45-60 euros par personne",
    "day_note": "string e.g. Ferme lundi et mardi",
    "terrace": false,
    "walk_in": false,
    "sources": "string"
  }
]`;

  const raw = await callAnthropic(
    [{ role: 'user', content: prompt }],
    'You are a JSON API. Output only a valid JSON array starting with [ and ending with ]. ASCII only in all string values.'
  );

  // Extract JSON array
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error(`No JSON array in response for ${ordinal}`);
  return JSON.parse(raw.slice(start, end + 1));
}

// ── Sleep helper ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('Table & Metro — Cache Generator');
  console.log(`Generating ${ARRONDISSEMENTS.length} arrondissements...\n`);

  const result = {
    generated_at: new Date().toISOString(),
    arrondissements: {}
  };

  // Load existing cache if present (to resume interrupted runs)
  const outPath = path.join(__dirname, 'restaurants.json');
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      result.arrondissements = existing.arrondissements || {};
      console.log(`Loaded existing cache with ${Object.keys(result.arrondissements).length} arrondissements\n`);
    } catch(e) {
      console.log('Could not load existing cache, starting fresh\n');
    }
  }

  for (const arr of ARRONDISSEMENTS) {
    const key = String(arr);

    // Skip if already cached (comment out to force refresh)
    if (result.arrondissements[key]) {
      console.log(`  ${arr}ème — skipped (already cached)`);
      continue;
    }

    process.stdout.write(`  ${arr}ème — generating...`);

    try {
      const restaurants = await generateForArrondissement(arr);
      result.arrondissements[key] = restaurants;
      process.stdout.write(` ✓ ${restaurants.length} restaurants\n`);

      // Save after each arrondissement so progress isn't lost on crash
      result.generated_at = new Date().toISOString();
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    } catch(e) {
      process.stdout.write(` ✗ ERROR: ${e.message}\n`);
      // Continue with next arrondissement rather than crashing
    }

    // Rate limit pause between calls
    if (arr !== ARRONDISSEMENTS[ARRONDISSEMENTS.length - 1]) {
      await sleep(DELAY_MS);
    }
  }

  // Final save
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  const total = Object.values(result.arrondissements).reduce((n, arr) => n + arr.length, 0);
  console.log(`\nDone. ${total} restaurants across ${Object.keys(result.arrondissements).length} arrondissements`);
  console.log(`Saved to ${outPath}`);
  console.log(`\nNext step: commit restaurants.json to your GitHub repo`);
  console.log(`  git add restaurants.json && git commit -m "Refresh restaurant cache" && git push`);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
