#!/bin/bash

# BlueQuant 停止脚本
echo "🛑 停止 BlueQuant..."

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

# 检查应用是否在运行
if npx pm2 list | grep -q "bluequant"; then
    print_status "停止应用..."
    npx pm2 stop bluequant
    
    if [ $? -eq 0 ]; then
        print_success "应用已停止！"
        echo ""
        echo "📊 当前状态:"
        npx pm2 status
    else
        echo "❌ 停止应用失败"
        exit 1
    fi
else
    print_warning "应用未在运行"
fi 