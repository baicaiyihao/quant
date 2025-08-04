#!/bin/bash

# BlueQuant 安装脚本
echo "🚀 开始安装 BlueQuant..."

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 Node.js 是否安装
check_node() {
    if ! command -v node &> /dev/null; then
        print_error "Node.js 未安装，请先安装 Node.js"
        exit 1
    fi
    
    NODE_VERSION=$(node -v)
    print_success "Node.js 版本: $NODE_VERSION"
}

# 检查 npm 是否安装
check_npm() {
    if ! command -v npm &> /dev/null; then
        print_error "npm 未安装"
        exit 1
    fi
    
    NPM_VERSION=$(npm -v)
    print_success "npm 版本: $NPM_VERSION"
}

# 安装 PM2
install_pm2() {
    print_status "检查 PM2 是否已安装..."
    # 使用 npx 检查 pm2 是否可用
    if npx pm2 -v &> /dev/null; then
        PM2_VERSION=$(npx pm2 -v)
        print_success "PM2 已安装，版本: $PM2_VERSION"
    else
        print_status "安装 PM2..."
        npm install pm2
        if [ $? -eq 0 ]; then
            print_success "PM2 安装成功"
        else
            print_error "PM2 安装失败"
            exit 1
        fi
    fi
}

# 安装项目依赖
install_dependencies() {
    print_status "安装项目依赖..."
    npm install
    if [ $? -eq 0 ]; then
        print_success "依赖安装成功"
    else
        print_error "依赖安装失败"
        exit 1
    fi
}

# 创建必要的目录
create_directories() {
    print_status "创建必要的目录..."
    mkdir -p logs
    mkdir -p dist
    print_success "目录创建完成"
}

# 检查环境变量文件
check_env() {
    print_status "检查环境变量配置..."
    if [ ! -f ".env" ]; then
        print_warning ".env 文件不存在，正在创建示例文件..."
        cp env.example .env
        print_warning "请编辑 .env 文件，设置正确的 API_KEY 和其他配置"
        print_warning "特别是 API_KEY 必须设置，否则应用无法启动"
    else
        print_success ".env 文件已存在"
    fi
}

# 构建项目
build_project() {
    print_status "构建项目..."
    npm run build
    if [ $? -eq 0 ]; then
        print_success "项目构建成功"
    else
        print_error "项目构建失败"
        exit 1
    fi
}

# 启动应用
start_application() {
    print_status "启动应用..."
    
    # 检查是否已经在运行
    if npx pm2 list | grep -q "bluequant"; then
        print_warning "应用已在运行，正在重启..."
        npx pm2 restart bluequant
    else
        npx pm2 start ecosystem.config.js
    fi
    
    if [ $? -eq 0 ]; then
        print_success "应用启动成功"
    else
        print_error "应用启动失败"
        exit 1
    fi
}

# 保存 PM2 配置
save_pm2_config() {
    print_status "保存 PM2 配置..."
    npx pm2 save
    if [ $? -eq 0 ]; then
        print_success "PM2 配置已保存"
    else
        print_warning "PM2 配置保存失败"
    fi
}

# 显示状态
show_status() {
    echo ""
    print_status "显示应用状态..."
    npx pm2 status
    echo ""
    print_status "显示应用日志..."
    npx pm2 logs bluequant --lines 10
}

# 显示使用说明
show_usage() {
    echo ""
    echo "📋 使用说明:"
    echo "=================="
    echo "启动应用:   npm run pm2:start"
    echo "停止应用:   npm run pm2:stop"
    echo "重启应用:   npm run pm2:restart"
    echo "查看日志:   npm run pm2:logs"
    echo "查看状态:   npm run pm2:status"
    echo "删除应用:   npm run pm2:delete"
    echo ""
    echo "🌐 API 接口:"
    echo "=================="
    echo "启动策略:   curl -X POST http://localhost:8080/start -H 'x-api-key: YOUR_API_KEY'"
    echo "停止策略:   curl -X POST http://localhost:8080/stop -H 'x-api-key: YOUR_API_KEY'"
    echo "获取状态:   curl -X GET http://localhost:8080/status -H 'x-api-key: YOUR_API_KEY'"
    echo "健康检查:   curl -X GET http://localhost:8080/health"
    echo ""
    echo "⚠️  重要提醒:"
    echo "=================="
    echo "1. 请确保 .env 文件中的 API_KEY 已正确设置"
    echo "2. 应用会自动重启，确保服务持续运行"
    echo "3. 日志文件保存在 logs/ 目录下"
    echo "4. 使用 pm2 monit 可以查看实时监控"
}

# 主函数
main() {
    echo "=================================="
    echo "    BlueQuant 安装脚本"
    echo "=================================="
    echo ""
    
    # 执行安装步骤
    check_node
    check_npm
    install_pm2
    install_dependencies
    create_directories
    # check_env
    build_project
    start_application
    save_pm2_config
    show_status
    show_usage
    
    echo ""
    print_success "🎉 安装完成！"
    echo ""
}

# 执行主函数
main 