#!/bin/sh
# Run on Linux or macOS: no Developer ID, Electron build, or Apple tools needed.
set -eu
. "$(dirname "$0")/../scripts/signing-scope.sh"

app=dist/TwinDesk.app
needs() {
  if signing_leaf_needs_entitlements "$1" "$app" "$2"; then
    [ "$3" = yes ] || { echo "Unexpected entitlements: $1" >&2; exit 1; }
  else
    [ "$3" = no ] || { echo "Missing executable entitlements: $1" >&2; exit 1; }
  fi
}

# Nested libraries, native addons and vendor tools must not gain device permissions.
needs "$app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" \
  'Mach-O 64-bit dynamically linked shared library arm64' no
needs "$app/Contents/Resources/app/mac/native.dylib" 'Mach-O universal binary' no
needs "$app/Contents/Resources/app/mac/node_modules/driver.node" 'Mach-O 64-bit bundle arm64' no
needs "$app/Contents/Resources/app/mac/vendor/adb/adb" 'Mach-O 64-bit executable arm64' no

# Electron helper and TwinDesk native executables retain their existing runtime entitlements.
needs "$app/Contents/Frameworks/TwinDesk Helper.app/Contents/MacOS/TwinDesk Helper" \
  'Mach-O 64-bit executable arm64' yes
needs "$app/Contents/Resources/app/mac-helper/.build/release/macshare-helper" \
  'Mach-O 64-bit executable arm64' yes

echo 'signing-scope: passed'
