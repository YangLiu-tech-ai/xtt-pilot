#!/bin/bash
# ============================================================
# 新通途 MVP · ECS 一键部署脚本
# 在新购买的 Ubuntu 22.04 ECS 上执行即可
#
# 使用方法:
#   1. 购买 ECS (Ubuntu 22.04, 1核2G, 开放 7788 端口)
#   2. SSH 登录: ssh root@<ECS_IP>
#   3. 上传此脚本: scp deploy-ecs.sh root@<ECS_IP>:/root/
#   4. 执行: bash /root/deploy-ecs.sh
#
# 执行完毕后服务地址:
#   http://<ECS_IP>:7788/v1/health
#   http://<ECS_IP>:7788/h5/preview.html?token=<YOUR_TOKEN>
# ============================================================

set -e

echo "=============================="
echo "新通途 MVP · ECS 部署开始"
echo "=============================="

# 1. 安装 Node.js 18
echo "[1/5] 安装 Node.js 18..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v)"
echo "  npm: $(npm -v)"

# 2. 安装 PM2
echo "[2/5] 安装 PM2..."
npm install -g pm2 2>/dev/null || true

# 3. 创建项目目录
echo "[3/5] 创建项目目录..."
PROJECT_DIR="/opt/xtt-mvp"
mkdir -p $PROJECT_DIR

# 检查代码是否已上传
if [ ! -f "$PROJECT_DIR/backend/server.js" ]; then
  echo ""
  echo "  ⚠️  请先上传项目代码到 $PROJECT_DIR"
  echo "  本地执行: scp -r xintongtu-mvp/* root@<ECS_IP>:$PROJECT_DIR/"
  echo ""
  echo "  上传完毕后重新运行此脚本。"
  exit 1
fi

# 4. 安装依赖
echo "[4/5] 安装 npm 依赖..."
cd $PROJECT_DIR/backend
npm install --production

# 5. 写环境变量
cat > $PROJECT_DIR/backend/.env << 'EOF'
PORT=7788
MVP_INTERNAL_KEY=worker-key-2026
NODE_ENV=production
EOF

# 6. PM2 启动
echo "[5/5] PM2 启动服务..."
pm2 delete xtt-mvp 2>/dev/null || true
pm2 start server.js --name xtt-mvp --cwd $PROJECT_DIR/backend
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "=============================="
echo "✅ 部署完成！"
echo "=============================="
echo ""
echo "服务地址:"
echo "  Health: http://$(curl -s ifconfig.me):7788/v1/health"
echo "  H5:     http://$(curl -s ifconfig.me):7788/h5/preview.html?token=<TOKEN>"
echo ""
echo "常用命令:"
echo "  pm2 logs xtt-mvp     # 查看日志"
echo "  pm2 restart xtt-mvp  # 重启"
echo "  pm2 status            # 查看状态"
echo ""
echo "更新代码后:"
echo "  cd $PROJECT_DIR/backend && pm2 restart xtt-mvp"
echo ""
