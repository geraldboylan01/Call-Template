#!/bin/zsh
cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/serve-presenter-controls.mjs
read -r '?Press Return to close.'
