#!/bin/bash

# ===========================================
# English Speaking Coach - 启动脚本
# ===========================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}   English Speaking Coach - 启动脚本${NC}"
echo -e "${BLUE}================================================${NC}"

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo -e "\n${YELLOW}警告: .env 文件不存在${NC}"
    if [ -f ".env.example" ]; then
        echo "正在从 .env.example 创建..."
        cp .env.example .env
        echo -e "${RED}请编辑 .env 文件并填入您的 API Keys${NC}"
        echo -e "${RED}然后重新运行此脚本${NC}"
        exit 1
    else:
        echo -e "${RED}无法找到 .env.example 文件${NC}"
        exit 1
    fi
fi

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo -e "\n${RED}错误: 未找到 Python 3${NC}"
    exit 1
fi

echo -e "\n${GREEN}检查依赖...${NC}"

# ===========================================
# 后端设置
# ===========================================
echo -e "\n${BLUE}>>> 后端设置${NC}"

cd "$PROJECT_ROOT/backend"

# 创建虚拟环境
if [ ! -d "venv" ]; then
    echo "创建 Python 虚拟环境..."
    python3 -m venv venv
fi

# 激活虚拟环境
echo "安装后端依赖..."
source venv/bin/activate

# 安装依赖
pip install --upgrade pip -q
pip install -r requirements.txt -q

# ===========================================
# 前端设置
# ===========================================
echo -e "\n${BLUE}>>> 前端设置${NC}"

cd "$PROJECT_ROOT/frontend"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo -e "\n${RED}错误: 未找到 npm${NC}"
    exit 1
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    echo "安装前端依赖..."
    npm install
fi

# ===========================================
# 启动服务
# ===========================================
cd "$PROJECT_ROOT"

echo -e "\n${BLUE}================================================${NC}"
echo -e "${GREEN}✓ 依赖安装完成！${NC}"
echo -e "${BLUE}================================================${NC}"

echo -e "\n${YELLOW}选择启动方式：${NC}"
echo ""
echo "  1) 使用 Docker Compose (推荐)"
echo "  2) 手动启动 (两个终端)"
echo "  3) 仅启动后端"
echo "  4) 仅启动前端"
echo "  5) 退出"
echo ""

read -p "请选择 [1-5]: " choice

case $choice in
    1)
        echo -e "\n${GREEN}使用 Docker Compose 启动...${NC}"
        docker-compose up --build
        ;;
    2)
        echo -e "\n${YELLOW}请在两个终端中分别运行以下命令：${NC}"
        echo ""
        echo -e "${GREEN}终端 1 - 后端:${NC}"
        echo "  cd $PROJECT_ROOT/backend"
        echo "  source venv/bin/activate"
        echo "  uvicorn main:app --reload"
        echo ""
        echo -e "${GREEN}终端 2 - 前端:${NC}"
        echo "  cd $PROJECT_ROOT/frontend"
        echo "  npm run dev"
        echo ""
        ;;
    3)
        echo -e "\n${GREEN}启动后端服务...${NC}"
        cd "$PROJECT_ROOT/backend"
        source venv/bin/activate
        uvicorn main:app --reload
        ;;
    4)
        echo -e "\n${GREEN}启动前端服务...${NC}"
        cd "$PROJECT_ROOT/frontend"
        npm run dev
        ;;
    5)
        echo "退出"
        exit 0
        ;;
    *)
        echo -e "\n${RED}无效选择${NC}"
        exit 1
        ;;
esac
