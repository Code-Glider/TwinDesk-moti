// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Retain explicit local setting changes made while a previously connected peer is offline.
'use strict';

// Per-peer preferences are authoritative when reconnecting, unless their local owner changed a
// switch after that peer disconnected. Copy only those changed directions/values; preserve all
// unrelated per-peer choices (and never copy settings from a different peer).
function offlineChanges(saved, before, after) {
  if (!before || !after) return null;
  const next = { ...(saved || {}) };
  let changed = false;

  for (const [feature, current] of Object.entries(after)) {
    if (!current || typeof current !== 'object') continue;
    const previous = before[feature];
    if (!previous || typeof previous !== 'object') continue;
    const keys = feature === 'values' ? Object.keys(current) : ['out', 'in'];
    for (const key of keys) {
      const value = current[key];
      if (value === undefined || value === previous[key]) continue;
      if (feature !== 'values' && (typeof value !== 'boolean' || typeof previous[key] !== 'boolean')) continue;
      if (feature === 'values' && !Object.prototype.hasOwnProperty.call(previous, key)) continue;
      const existing = next[feature] || {};
      if (existing[key] === value) continue;
      next[feature] = { ...existing, [key]: value };
      changed = true;
    }
  }

  return changed ? next : null;
}

module.exports = { offlineChanges };
