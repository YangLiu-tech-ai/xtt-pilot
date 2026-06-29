@echo off
set "WHALE_REFRESH_TOKEN=VThT58bbOgRh10GFs8PJBEo__y-_nuVvmelG8DCmQaAZcYGUpv0k8qGw_AXO9RIEAxLlaQQt6Mbpf11xssgShLGlP_VARz5ysbFXmfl0x753ScP_cgRVSSaSV-XzpdSr"
set "WHALE_SHOP_ID=1579337942525061"
set "WHALE_BASE_URL=https://whale.zwztf.net"
set "RENDER_API=https://xtt-pilot.onrender.com"
set "INTERNAL_KEY=worker-key-2026-prod"
node scripts/worker-api.js
