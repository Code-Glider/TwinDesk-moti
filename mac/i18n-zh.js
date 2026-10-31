// TwinDesk Mac — Simplified Chinese UI.
//
// Loaded right after control.js and before the page scripts, so the observer is
// in place before the first page renders. Outside a Chinese system locale this
// file does nothing at all.
//
// Why a DOM pass instead of wrapping the UI kit: the Mac app has no shared
// string helper — the shell writes textContent directly and each page sets its
// own innerHTML — so the one place every string passes through is the document
// itself. Three entry points cover it:
//
//   1. text nodes  - whole-node exact match against window.__ZH_MAC, whitespace
//                    on both sides preserved;
//   2. attributes  - placeholder / aria-label / title, which the passes above
//                    never see;
//   3. patterns    - the few runtime-composed sentences (a device name glued to
//                    a sentence) that no exact match can express.
//
// A node that was already translated is left alone: its text no longer matches
// an English key, so repeated passes are cheap and idempotent.
'use strict';

(function () {
  const DICT = window.__ZH_MAC;
  if (!DICT) return;

  // Simplified Chinese only: any other locale keeps the app exactly as it ships.
  const lang = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  if (!/^zh/i.test(lang)) return;

  document.documentElement.lang = 'zh-CN';

  // Runtime-composed sentences. Kept deliberately short: a rule that swallows a
  // device name is capped at three words, because a longer run of words means an
  // untranslated sentence and half-translated gibberish reads worse than English.
  const NAME = '([^\\s]+(?:\\s+[^\\s]+){0,2})';
  const RX = [
    [new RegExp('^TwinDesk on ' + NAME + ' wants to pair$'), '来自 $1 的 TwinDesk 请求配对'],
    [new RegExp('^' + NAME + ' wants to pair$'), '$1 请求配对'],
    [new RegExp('^' + NAME + ' is connected$'), '$1 已连接'],
    [new RegExp('^Connected to ' + NAME + '$'), '已连接到 $1'],
    [new RegExp('^' + NAME + ' · (\\d+) ms$'), '$1 · $2 毫秒'],
    [new RegExp('^Version (\\S+) · checked (.+)$'), '版本 $1 · 检查于 $2'],
    [new RegExp('^Version (\\S+)$'), '版本 $1'],
  ];

  const ATTRS = ['placeholder', 'aria-label', 'title'];

  function translate(value) {
    const key = String(value).trim();
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(DICT, key)) return DICT[key];
    for (const [re, out] of RX) {
      if (re.test(key)) return key.replace(re, out);
    }
    return null;
  }

  function translateTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return;
    const out = translate(raw);
    if (out === null) return;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    const next = lead + out + trail;
    if (next !== raw) node.nodeValue = next;
  }

  function translateAttributes(el) {
    for (const name of ATTRS) {
      const value = el.getAttribute && el.getAttribute(name);
      if (!value) continue;
      const out = translate(value);
      if (out !== null && out !== value) el.setAttribute(name, out);
    }
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP.has(root.tagName)) return;
    translateAttributes(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !SKIP.has(parent.tagName)) translateTextNode(node);
      node = walker.nextNode();
    }
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll('[placeholder],[aria-label],[title]')) translateAttributes(el);
    }
  }

  // Coalesce bursts (a page renders dozens of nodes at once) into one pass.
  let queued = false;
  const pending = new Set();
  function flush() {
    queued = false;
    for (const node of pending) {
      if (node.isConnected) translateTree(node);
    }
    pending.clear();
  }
  function queue(node) {
    pending.add(node);
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
  }

  function boot() {
    translateTree(document.body);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          queue(record.target);
          continue;
        }
        for (const node of record.addedNodes) queue(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
