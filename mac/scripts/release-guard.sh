#!/bin/sh
# TwinDesk — GPL-3.0, see LICENSE.
# Artifact-only builds may be self-signed. Public tagged releases require a verified imported
# Developer ID Application identity and all three Apple notarization credentials.
set -eu

tag=${RELEASE_TAG:-}
ready=${TWIN_DESK_DEVELOPER_ID_READY:-}
source_ref=${RELEASE_SOURCE_REF:-main}
workflow_ref=${GITHUB_REF:-}

if [ -n "$tag" ] && { [ "$source_ref" != main ] || [ "$workflow_ref" != refs/heads/main ]; }; then
  echo '::error title=Release source::Tagged macOS releases must build main from the main workflow ref.' >&2
  exit 1
fi

if [ "$ready" != 1 ] || [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  if [ -n "$tag" ]; then
    echo '::error title=Unnotarized release blocked::Import a Developer ID Application certificate and configure all Apple notary credentials before uploading a tagged DMG.' >&2
    exit 1
  fi
  echo '::warning title=macOS test artifact::No verified Developer ID and/or complete notarization credentials; this DMG is not a public-release artifact.'
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo '⚠️ macOS test artifact only — Developer ID signing and/or notarization are not configured.' >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

echo 'Developer ID identity imported; notarization credentials configured.'
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo 'macOS signing: verified Developer ID Application identity imported; notarization credentials configured.' >> "$GITHUB_STEP_SUMMARY"
fi
