$env:WHALE_REFRESH_TOKEN = 'VThT58bbOgRh10GFs8PJBEo__y-_nuVvmelG8DCmQaAZcYGUpv0k8qGw_AXO9RIEAxLlaQQt6Mbpf11xssgShLGlP_VARz5ysbFXmfl0x753ScP_cgRVSSaSV-XzpdSr'
$env:WHALE_SHOP_ID = '1579337942525061'
$env:WHALE_BASE_URL = 'https://whale.zwztf.net'
$env:RENDER_API = 'https://xtt-pilot.onrender.com'
$env:INTERNAL_KEY = 'worker-key-2026-prod'
Write-Host ('TOKEN_LEN=' + $env:WHALE_REFRESH_TOKEN.Length)
node scripts/worker-api.js
