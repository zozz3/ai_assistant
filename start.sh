# English Speaking Coach - 启动脚本

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}   English Speaking Coach - 启动脚本${NC}"
echo -e "${BLUE}================================================${NC}"

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}警告: .env 文件不存在，正在创建...${NC}"
    cp .env.example .env
    echo -e "${RED}请编辑 .env 文件并填入您的 API Keys${NC}"
fi

# 检查后端依赖
echo -e "\n${GREEN}检查后端依赖...${NC}"
cd backend
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}创建 Python 虚拟环境...${NC}"
    python -m venv venv
fi

# 激活虚拟环境并安装依赖
echo -e "${GREEN}安装后端依赖...${NC}"
source venv/bin/activate
pip install -r requirements.txt -q
deactivate

# 检查前端依赖
echo -e "\n${GREEN}检查前端依赖...${NC}"
cd ../frontend
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}安装前端依赖...${NC}"
    npm install
fi

# 返回项目根目录
cd "$PROJECT_ROOT"

echo -e "\n${BLUE}================================================${NC}"
echo -e "${GREEN}依赖安装完成！${NC}"
echo -e "${BLUE}================================================${NC}"
echo -e "\n启动方式:"
echo -e "  ${YELLOW}方式1: 使用 Docker${NC}"
echo -e "    ${GREEN}docker-compose up${NC}"
echo -e ""
echo -e "  ${YELLOW}方式2: 手动启动${NC}"
echo -e "    终端1: ${GREEN}cd backend && source venv/bin/activate && python main.py${NC}"
echo -e "    终端2: ${GREEN}cd frontend && npm run dev${NC}"
echo ""
echo -e "  ${YELLOW}方式3: 分别启动${NC}"
echo -e "    后端: ${GREEN}cd backend && source venv/bin/activate && uvicorn main:app --reload${NC}"
echo -e "    前端: ${GREEN}cd frontend && npm run dev${NC}"
echo ""
echo -e "${BLUE}================================================${NC}"
echo -e "访问地址:"
echo -e "  前端: ${GREEN}http://localhost:5173${NC}"
echo -e "  后端API: ${GREEN}http://localhost:8000${NC}"
echo -e "  API文档: ${GREEN}http://localhost:8000/docs${NC}"
echo -e "${BLUE}================================================${NC}"
