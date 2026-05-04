#!/usr/bin/env bash

set -euo pipefail

EXPECTED_VERSION="${GITHUB_SHA:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:0:16}"

if [[ -z "$EXPECTED_VERSION" ]]; then
  echo "GITHUB_SHA is required for deploy verification" >&2
  exit 1
fi

SITE_ORIGIN=""

if [[ -f "CNAME" ]]; then
  SITE_ORIGIN="$(tr -d '[:space:]' < CNAME)"
fi

if [[ -z "$SITE_ORIGIN" ]]; then
  SITE_ORIGIN="${PAGE_URL:-}"
fi

if [[ -z "$SITE_ORIGIN" ]]; then
  echo "Neither CNAME nor PAGE_URL provided a site origin" >&2
  exit 1
fi

if [[ "$SITE_ORIGIN" != http://* && "$SITE_ORIGIN" != https://* ]]; then
  SITE_ORIGIN="https://${SITE_ORIGIN}"
fi

SITE_ORIGIN="${SITE_ORIGIN%/}"
LANDING_URL="${SITE_ORIGIN}/"
APP_URL="${SITE_ORIGIN}/app/"
ROBOTS_URL="${SITE_ORIGIN}/robots.txt"
SITEMAP_URL="${SITE_ORIGIN}/sitemap.xml"

fetch_html() {
  local url="$1"
  curl --fail --silent --show-error --location \
    --header 'Cache-Control: no-cache' \
    --header 'Pragma: no-cache' \
    "$url"
}

assert_contains() {
  local html="$1"
  local needle="$2"
  local label="$3"

  if [[ "$html" != *"$needle"* ]]; then
    echo "Missing expected asset marker for ${label}: ${needle}" >&2
    exit 1
  fi
}

landing_html="$(fetch_html "$LANDING_URL")"
app_html="$(fetch_html "$APP_URL")"
robots_txt="$(fetch_html "$ROBOTS_URL")"
sitemap_xml="$(fetch_html "$SITEMAP_URL")"
app_js="$(fetch_html "${SITE_ORIGIN}/js/app.js?v=${EXPECTED_VERSION}")"
render_js="$(fetch_html "${SITE_ORIGIN}/js/render.js?v=${EXPECTED_VERSION}")"
session_viewer_js="$(fetch_html "${SITE_ORIGIN}/js/session_viewer.js?v=${EXPECTED_VERSION}")"
landing_css="$(fetch_html "${SITE_ORIGIN}/styles/landing.css?v=${EXPECTED_VERSION}")"

assert_contains "$landing_html" "<title>Planeir | Irish Financial Education Calls with Gerry Boylan</title>" "landing title"
assert_contains "$landing_html" '<link rel="canonical" href="https://planeir.ie/"' "landing canonical"
assert_contains "$landing_html" 'application/ld+json' "landing structured data"
assert_contains "$landing_html" 'og:image' "landing Open Graph image"
assert_contains "$landing_html" "./styles/landing.css?v=${EXPECTED_VERSION}" "landing stylesheet"
assert_contains "$landing_html" "./js/landing.js?v=${EXPECTED_VERSION}" "landing script"
assert_contains "$landing_html" "./assets/brand/planeir-wordmark-light.svg?v=${EXPECTED_VERSION}" "landing wordmark"

assert_contains "$robots_txt" "Sitemap: https://planeir.ie/sitemap.xml" "robots sitemap declaration"
assert_contains "$sitemap_xml" "<loc>https://planeir.ie/</loc>" "sitemap canonical URL"

assert_contains "$app_html" '<meta name="robots" content="noindex, nofollow"' "app noindex"
assert_contains "$app_html" "../styles/base.css?v=${EXPECTED_VERSION}" "app stylesheet"
assert_contains "$app_html" "../js/app.js?v=${EXPECTED_VERSION}" "app script"
assert_contains "$app_html" "../assets/brand/planeir-wordmark-light.svg?v=${EXPECTED_VERSION}" "app wordmark"

assert_contains "$app_js" "./state.js?v=${EXPECTED_VERSION}" "app -> state module import"
assert_contains "$app_js" "./render.js?v=${EXPECTED_VERSION}" "app -> render module import"
assert_contains "$render_js" "./education_svg.js?v=${EXPECTED_VERSION}" "render -> education svg module import"
assert_contains "$render_js" "./report.js?v=${EXPECTED_VERSION}" "render -> report module import"
assert_contains "$session_viewer_js" "./app.js?v=${EXPECTED_VERSION}" "session viewer dynamic import"
assert_contains "$landing_css" "../assets/brand/planeir-harp-light.svg?v=${EXPECTED_VERSION}" "landing CSS brand asset"

echo "Verified versioned Pages asset URLs for ${SITE_ORIGIN} (${EXPECTED_VERSION})"
