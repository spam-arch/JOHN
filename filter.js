'use strict';
// Text filter used by the bot: blocklist (never posted, never learned), watchlist (held for approval),
// and link detection. Matching ignores capitals, accents, symbols between letters, stretched letters
// ("pooorn") and common lookalike characters ("p0rn", "p.o.r.n").

const fs = require('fs');

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

// Two readings of the text: as written, and with lookalike characters turned into letters.
function variants(text) {
  const base = String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const leet = base.replace(/[013457@$!]/g, (c) => LEET[c]);
  return [base, leet].map((t) => ({
    spaced: ` ${t.replace(/[^a-z]+/g, ' ').trim()} `, // words separated by single spaces
    squashed: t.replace(/[^a-z]+/g, ''), // letters only, no spaces
  }));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Turn one list entry into a matcher.
function compileTerm(entry) {
  let term = entry.trim();
  if (!term || term.startsWith('#')) return null;
  const stem = term.startsWith('~');
  if (stem) term = term.slice(1).trim();
  const lower = term.toLowerCase();

  // Entries that aren't plain letters (emoji etc.) are matched exactly, anywhere in the text.
  if (/[^a-z\s'-]/i.test(lower.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))) {
    return { term, raw: lower };
  }

  const letters = lower.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  if (letters.length < 2) return null;
  const runs = letters.match(/(.)\1*/g); // "pussy" -> p, u, ss, y
  const run = (r) => `${r[0]}{${r.length},}`; // a doubled letter must stay doubled; extra repeats are fine

  if (stem) {
    return { term, squashRe: new RegExp(runs.map(run).join('')) };
  }
  const compact = runs.map(run).join(letters.length >= 5 ? ' ?' : '');
  let body = compact;
  if (letters.length <= 4 && runs.length > 1) {
    // short words: also catch the letters spread out with single spaces ("p o r n")
    body = `(?:${compact}|${letters.split('').join(' ')})`;
  }
  return { term, wordRe: new RegExp(` ${body}(?:s|es)? `) };
}

function compile(entries) {
  return entries.map(compileTerm).filter(Boolean);
}

function firstHit(matchers, text) {
  if (!matchers.length || !text) return null;
  const lower = String(text).toLowerCase();
  const vs = variants(text);
  for (const m of matchers) {
    if (m.raw) {
      if (lower.includes(m.raw)) return m.term;
    } else if (m.wordRe) {
      if (vs.some((v) => m.wordRe.test(v.spaced))) return m.term;
    } else if (m.squashRe) {
      if (vs.some((v) => m.squashRe.test(v.squashed))) return m.term;
    }
  }
  return null;
}

const LINK_RE =
  /(https?:\/\/|www\.|discord\.gg\b|discord(?:app)?\.com\/invite|\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|tv|xyz|app|link|ly|dev|info|shop|biz|us|uk|ru|cn|fm)\b)/i;

function loadList(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not read ${file}: ${err.message}`);
    return [];
  }
}

function createFilter({ blocklist = [], watchlist = [] } = {}) {
  const block = compile(blocklist);
  const watch = compile(watchlist);
  return {
    blockedTerm: (text) => firstHit(block, text), // returns the matching list entry, or null
    watchedTerm: (text) => firstHit(watch, text),
    hasLink: (text) => LINK_RE.test(String(text || '')),
    counts: { blocklist: block.length, watchlist: watch.length },
  };
}

module.exports = { createFilter, loadList };
