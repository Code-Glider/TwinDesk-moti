// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Build with gcc -std=gnu11 -Wall -Wextra -Werror -Ilinux-helper/src
// and link input-probe-cache.c plus this test file.
#include "input-probe-cache.h"
#include <assert.h>
#include <stdio.h>

static struct stat id(int dev, int rdev, int ino) {
  struct stat s = { 0 };
  s.st_dev = dev;
  s.st_rdev = rdev;
  s.st_ino = ino;
  return s;
}

int main(void) {
  InputProbeCache cache = { 0 };
  struct stat old = id(1, 100, 20), replaced = id(1, 100, 21);
  assert(!input_probe_rejected(&cache, "/dev/input/event3", &old));
  input_probe_remember(&cache, "/dev/input/event3", &old);
  assert(input_probe_rejected(&cache, "/dev/input/event3", &old));
  assert(!input_probe_rejected(&cache, "/dev/input/event4", &old));
  assert(!input_probe_rejected(&cache, "/dev/input/event3", &replaced)); // same node number, new inode
  input_probe_remember(&cache, "/dev/input/event3", &replaced);
  assert(input_probe_rejected(&cache, "/dev/input/event3", &replaced));
  assert(!input_probe_rejected(&cache, "/dev/input/event3", &old));
  struct stat changedRdev = id(1, 101, 21), changedFs = id(2, 100, 21);
  assert(!input_probe_rejected(&cache, "/dev/input/event3", &changedRdev));
  assert(!input_probe_rejected(&cache, "/dev/input/event3", &changedFs));

  // Repeated hotplug eventually evicts old entries instead of freezing the cache forever.
  char path[300];
  for (int i = 0; i < INPUT_PROBE_CACHE_MAX + 2; i++) {
    snprintf(path, sizeof path, "/dev/input/event%d", i + 100);
    struct stat s = id(1, 100 + i, 100 + i);
    input_probe_remember(&cache, path, &s);
    assert(input_probe_rejected(&cache, path, &s));
  }
  assert(cache.count == INPUT_PROBE_CACHE_MAX);
  struct stat evicted = id(1, 100, 100);
  assert(!input_probe_rejected(&cache, "/dev/input/event100", &evicted));
  puts("input-probe-cache: ok");
  return 0;
}
