#!/bin/sh
# Regression test: no real Apple signing credentials are used.
set -eu
script="$(dirname "$0")/../scripts/release-guard.sh"

check() {
  expected=$1
  shift
  if env "$@" sh "$script" >/dev/null 2>&1; then
    [ "$expected" = pass ] || { echo 'Unsigned release unexpectedly allowed' >&2; exit 1; }
  else
    [ "$expected" = fail ] || { echo 'Valid build unexpectedly blocked' >&2; exit 1; }
  fi
}

# Artifact-only workflows always remain runnable for local development and diagnosis.
check pass RELEASE_TAG= GITHUB_REF=refs/heads/feature RELEASE_SOURCE_REF=feature
check pass RELEASE_TAG= TWIN_DESK_DEVELOPER_ID_READY=0 GITHUB_REF=refs/heads/main

# Release artifacts must come from main and have both a verified Developer ID and notary creds.
check fail RELEASE_TAG=v2.5 GITHUB_REF=refs/heads/main RELEASE_SOURCE_REF=main
check fail RELEASE_TAG=v2.5 GITHUB_REF=refs/heads/main RELEASE_SOURCE_REF=feature TWIN_DESK_DEVELOPER_ID_READY=1 APPLE_ID=a APPLE_APP_SPECIFIC_PASSWORD=p APPLE_TEAM_ID=t
check fail RELEASE_TAG=v2.5 GITHUB_REF=refs/heads/feature RELEASE_SOURCE_REF=main TWIN_DESK_DEVELOPER_ID_READY=1 APPLE_ID=a APPLE_APP_SPECIFIC_PASSWORD=p APPLE_TEAM_ID=t
check fail RELEASE_TAG=v2.5 GITHUB_REF=refs/heads/main RELEASE_SOURCE_REF=main TWIN_DESK_DEVELOPER_ID_READY=0 APPLE_ID=a APPLE_APP_SPECIFIC_PASSWORD=p APPLE_TEAM_ID=t
check fail RELEASE_TAG=v2.5 GITHUB_REF=refs/heads/main RELEASE_SOURCE_REF=main TWIN_DESK_DEVELOPER_ID_READY=1 APPLE_ID=a APPLE_APP_SPECIFIC_PASSWORD=p APPLE_TEAM_ID=
check pass RELEASE_TAG=v2.5 GITHUB_REF=refs/heads/main RELEASE_SOURCE_REF=main TWIN_DESK_DEVELOPER_ID_READY=1 APPLE_ID=a APPLE_APP_SPECIFIC_PASSWORD=p APPLE_TEAM_ID=t

echo 'release-guard: passed'
