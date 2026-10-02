# English Speaking Coach - 快速部署指南

## 📋 前置要求

- Python 3.9+
- Node.js 18+
- npm 或 yarn
- 阿里云 DashScope API Key
- OpenAI API Key
- 阿里云万相数字人服务（可选）

## 🚀 快速启动

### 方式一：使用脚本（推荐）

**Windows:**
```powershell
.\start.ps1
```

**Linux/macOS:**
```bash
chmod +x start.sh
./start.sh
```

### 方式二：Docker 部署

```bash
# 构建并启动
docker-compose up --build

# 后台运行
docker-compose up -d
```

### 方式三：手动启动

**1. 配置环境变量**

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# DashScope API (ASR + TTS)
DASHSCOPE_API_KEY=your-dashscope-api-key

# OpenAI API (LLM)
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

**2. 启动后端**

```bash
cd backend

# 创建虚拟环境
python -m venv venv

# 激活虚拟环境
# Windows
.\venv\Scripts\activate
# Linux/macOS
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 启动服务
uvicorn main:app --reload
```

**3. 启动前端**

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

## 🌐 访问应用

- **前端**: http://localhost:5173
- **后端 API**: http://localhost:8000
- **API 文档**: http://localhost:8000/docs

## ⚙️ 配置说明

### 阿里云 DashScope

1. 访问 [阿里云 DashScope 控制台](https://dashscope.console.aliyun.com/)
2. 获取 API Key
3. 启用以下服务：
   - ASR（语音识别）：qwen-audio-3.1-asr-flash
   - TTS（语音合成）：qwen-audio-3.1-tts-flash

### OpenAI API

1. 访问 [OpenAI Platform](https://platform.openai.com/)
2. 获取 API Key
3. 推荐模型：GPT-4o-mini（速度快，成本低）

### 阿里云数字人（可选）

1. 访问 [阿里云数字人控制台](https://help.aliyun.com/zh/avatar/)
2. 开通数字人服务
3. 获取 App ID 和配置

## 🔧 故障排除

### 常见问题

**1. 麦克风权限被拒绝**

解决方案：
- 使用 Chrome 或 Edge 浏览器
- 确保使用 localhost 或 HTTPS 访问

**2. CORS 错误**

解决方案：
- 检查后端 CORS 配置
- 确保前端请求发送到正确的端口

**3. API 调用失败**

解决方案：
- 检查 .env 文件中的 API Keys
- 确认 API Key 有足够的配额

**4. 数字人无法加载**

解决方案：
- 确认数字人服务已开通
- 检查网络连接
- 确认 RTC 参数配置正确

## 📝 API 文档

启动服务后访问 http://localhost:8000/docs 查看完整的 API 文档。

## 🎯 使用流程

1. **初始化** - 点击"初始化数字人"按钮
2. **录音** - 点击麦克风按钮开始说话
3. **等待处理** - 系统自动进行 ASR → LLM → TTS
4. **查看回复** - AI 数字人回复并播报

## 🛠️ 开发指南

### 前端开发

```bash
cd frontend
npm run dev      # 开发模式
npm run build    # 生产构建
```

### 后端开发

```bash
cd backend
uvicorn main:app --reload  # 开发模式
python main.py             # 生产模式
```

## 📦 项目结构

```
english-speaking-coach/
├── backend/
│   ├── main.py              # FastAPI 应用入口
│   ├── config.py            # 配置文件
│   ├── api/                 # API 路由
│   │   ├── routes.py       # API 端点
│   │   └── models.py       # 数据模型
│   └── services/            # 业务服务
│       ├── asr_service.py   # 语音识别
│       ├── llm_service.py   # 对话生成
│       └── tts_service.py   # 语音合成
├── frontend/
│   ├── src/
│   │   ├── components/      # React 组件
│   │   ├── hooks/           # 自定义 Hooks
│   │   ├── services/        # API 服务
│   │   └── store/           # 状态管理
│   └── package.json
├── docker-compose.yml       # Docker 配置
└── README.md
```

## 🆘 获取帮助

- 提交 GitHub Issue
- 查看 API 文档：http://localhost:8000/docs
- 阿里云支持：https://help.aliyun.com/zh/avatar/
