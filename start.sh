#!/bin/bash

# BlueQuant 快速启动脚本
echo "🚀 启动 BlueQuant..."

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# 检查是否已构建
if [ ! -d "dist" ] || [ ! -f "dist/index.js" ]; then
    print_warning "项目未构建，正在构建..."
    npm run build
fi

# 检查环境变量
if [ ! -f ".env" ]; then
    print_warning ".env 文件不存在，请先运行 ./install.sh"
    exit 1
fi

# 启动应用
print_status "启动应用..."
if pm2 list | grep -q "bluequant"; then
    print_status "应用已在运行，正在重启..."
    pm2 restart bluequant
else
    pm2 start ecosystem.config.js
fi

if [ $? -eq 0 ]; then
    print_success "应用启动成功！"
    echo ""
    echo "📊 应用状态:"
    pm2 status
    echo ""
    echo "📋 常用命令:"
    echo "  查看日志:   pm2 logs bluequant"
    echo "  查看监控:   pm2 monit"
    echo "  停止应用:   pm2 stop bluequant"
    echo "  重启应用:   pm2 restart bluequant"
else
    echo "❌ 应用启动失败"
    exit 1
fi 