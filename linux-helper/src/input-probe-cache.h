// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Remember rejected evdev nodes without preventing a hotplug replacement from being probed.
#ifndef TWINDESK_INPUT_PROBE_CACHE_H
#define TWINDESK_INPUT_PROBE_CACHE_H

#include <stddef.h>
#include <sys/stat.h>

#define INPUT_PROBE_CACHE_MAX 128

typedef struct {
  char path[300];
  dev_t device, rdev;
  ino_t inode;
} InputProbeEntry;

typedef struct {
  InputProbeEntry entries[INPUT_PROBE_CACHE_MAX];
  size_t count, next;
} InputProbeCache;

int input_probe_rejected(const InputProbeCache *cache, const char *path, const struct stat *identity);
void input_probe_remember(InputProbeCache *cache, const char *path, const struct stat *identity);

#endif
