@echo off
set "WHALE_REFRESH_TOKEN=4123eYYIM93U1nXV4tMvApoKtBc_zFTTKcrbM8bRXHEGA_X4R5lVWLOdYOkO0udnu-6DyWc3kEsgS8jDhcfH3Kf6dzFg1dCwF37Y1miYAKovH_OC4BuAfCS7X3M9gzCL"
set "WHALE_SHOP_ID=1579337942525061"
set "WHALE_BASE_URL=https://whale.zwztf.net"
set "RENDER_API=https://xtt-pilot.onrender.com"
set "INTERNAL_KEY=worker-key-2026-prod"
node scripts/worker-api.js
