// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
#include "input-probe-cache.h"
#include <stdio.h>
#include <string.h>

static int same(const InputProbeEntry *e, const struct stat *st) {
  return e->device == st->st_dev && e->rdev == st->st_rdev && e->inode == st->st_ino;
}

int input_probe_rejected(const InputProbeCache *cache, const char *path, const struct stat *identity) {
  for (size_t i = 0; i < cache->count; i++) {
    if (!strcmp(cache->entries[i].path, path)) return same(&cache->entries[i], identity);
  }
  return 0;
}

void input_probe_remember(InputProbeCache *cache, const char *path, const struct stat *identity) {
  size_t slot = cache->count;
  for (size_t i = 0; i < cache->count; i++) {
    if (!strcmp(cache->entries[i].path, path)) { slot = i; break; }
  }
  if (slot == cache->count) {
    if (cache->count < INPUT_PROBE_CACHE_MAX) cache->count++;
    else { slot = cache->next; cache->next = (cache->next + 1) % INPUT_PROBE_CACHE_MAX; }
  }
  InputProbeEntry *e = &cache->entries[slot];
  snprintf(e->path, sizeof e->path, "%s", path);
  e->device = identity->st_dev;
  e->rdev = identity->st_rdev;
  e->inode = identity->st_ino;
}
