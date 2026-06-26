@echo off
REM ============================================================
REM 新通途 MVP · D4 cloudflared HTTPS 隧道启动脚本
REM 用法: 双击运行或在 cmd 中执行 start-tunnel.bat
REM 功能: 将 localhost:7788 暴露为公网 HTTPS URL (无需 CF 账号登录)
REM ============================================================

SET CLOUDFLARED=%~dp0..\cloudflared.exe

REM 检查 cloudflared 是否存在
IF NOT EXIST "%CLOUDFLARED%" (
    echo [ERROR] cloudflared.exe 不存在于 %CLOUDFLARED%
    echo 请从 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe 下载
    echo 并放到项目根目录
    pause
    exit /b 1
)

REM 检查服务是否在跑
curl -s http://localhost:7788/v1/health >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [WARN] localhost:7788 未响应，请先启动 server.js
    echo 运行: cd backend ^&^& node server.js
    pause
    exit /b 1
)

echo ============================================================
echo  新通途 MVP - cloudflared Quick Tunnel
echo  将 http://localhost:7788 暴露为公网 HTTPS
echo ============================================================
echo.
echo [INFO] 启动中... 等待 Cloudflare 分配域名...
echo [INFO] 域名格式: https://xxxx-xxxx-xxxx.trycloudflare.com
echo [INFO] 复制域名到钉钉 ActionCard 的 singleURL 中即可
echo [INFO] Ctrl+C 停止隧道
echo.

"%CLOUDFLARED%" tunnel --url http://localhost:7788
