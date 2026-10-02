# English Speaking Coach - 启动脚本 (PowerShell)

$GREEN = "`e[0;32m"
$YELLOW = "`e[1;33m"
$BLUE = "`e[0;34m"
$RED = "`e[0;31m"
$NC = "`e[0m"

$PROJECT_ROOT = $PSScriptRoot

Write-Host ""
Write-Host "$BLUE================================================$NC"
Write-Host "$BLUE   English Speaking Coach - 启动脚本$NC"
Write-Host "$BLUE================================================$NC"

# 检查 .env 文件
if (-not (Test-Path ".env")) {
    Write-Host "$YELLOW 警告: .env 文件不存在，正在创建... $NC"
    Copy-Item ".env.example" ".env"
    Write-Host "$RED 请编辑 .env 文件并填入您的 API Keys $NC"
}

# 检查并创建后端虚拟环境
Write-Host ""
Write-Host "$GREEN 检查后端依赖... $NC"
Set-Location "$PROJECT_ROOT\backend"
if (-not (Test-Path "venv")) {
    Write-Host "$YELLOW 创建 Python 虚拟环境... $NC"
    python -m venv venv
}

# 激活虚拟环境并安装依赖
Write-Host "$GREEN 安装后端依赖... $NC"
& ".\venv\Scripts\Activate.ps1" -ErrorAction SilentlyContinue
pip install -r requirements.txt -q
deactivate

# 检查前端依赖
Write-Host ""
Write-Host "$GREEN 检查前端依赖... $NC"
Set-Location "$PROJECT_ROOT\frontend"
if (-not (Test-Path "node_modules")) {
    Write-Host "$YELLOW 安装前端依赖... $NC"
    npm install
}

# 返回项目根目录
Set-Location $PROJECT_ROOT

Write-Host ""
Write-Host "$BLUE================================================$NC"
Write-Host "$GREEN 依赖安装完成！ $NC"
Write-Host "$BLUE================================================$NC"
Write-Host ""
Write-Host "启动方式:"
Write-Host "  $YELLOW 方式1: 使用 Docker $NC"
Write-Host "    $GREEN docker-compose up $NC"
Write-Host ""
Write-Host "  $YELLOW 方式2: 手动启动 $NC"
Write-Host "    终端1: $GREEN cd backend; .\venv\Scripts\Activate; python main.py $NC"
Write-Host "    终端2: $GREEN cd frontend; npm run dev $NC"
Write-Host ""
Write-Host "  $YELLOW 方式3: 分别启动 $NC"
Write-Host "    后端: $GREEN cd backend; .\venv\Scripts\Activate; uvicorn main:app --reload $NC"
Write-Host "    前端: $GREEN cd frontend; npm run dev $NC"
Write-Host ""
Write-Host "$BLUE================================================$NC"
Write-Host "访问地址:"
Write-Host "  前端: $GREEN http://localhost:5173 $NC"
Write-Host "  后端API: $GREEN http://localhost:8000 $NC"
Write-Host "  API文档: $GREEN http://localhost:8000/docs $NC"
Write-Host "$BLUE================================================$NC"
Write-Host ""
