#!/bin/sh
# TwinDesk — GPL-3.0, see LICENSE.
# Return true only for Mach-O executables that need the app's runtime entitlements.
# Library code and third-party vendor tools are signed, but must not inherit the app's
# privacy and Hardened Runtime exception entitlements.
signing_leaf_needs_entitlements() {
  case "$1" in
    "$2"/Contents/Resources/app/mac/vendor/*|*.dylib|*.so|*.node) return 1 ;;
  esac
  case "$3" in
    *'shared library'*|*'bundle'*) return 1 ;;
  esac
  return 0
}
