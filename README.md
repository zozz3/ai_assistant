# English Speaking Coach

English Speaking Coach 是一个基于 AI 的英语口语陪练应用，集成了语音识别、LLM 对话、语音合成和数字人形象驱动。

## 📹 演示视频

演示应用的完整对话流程：**麦克风录音 → ASR 语音识别 → LLM 对话处理 → TTS 语音合成 → 数字人形象驱动输出**

🎬 **[点击播放演示视频 (test.mp4)](test.mp4)**

<details>
<summary>在页面内直接播放（浏览器支持 video 标签时可用）</summary>

```html
<video src="https://github.com/zozz3/ai_assistant/raw/master/test.mp4"
       controls width="100%" preload="metadata">
  你的浏览器不支持 video 标签，请
  <a href="https://github.com/zozz3/ai_assistant/raw/master/test.mp4">点击这里下载视频</a>查看。
</video>
```

</details>

> 📥 视频文件约 74 MB，如浏览器无法直接播放，请
> <a href="https://github.com/zozz3/ai_assistant/raw/master/test.mp4">点击此处下载</a>
> 后用本地播放器打开。

## 功能特性

- 🎤 **实时语音输入** - 使用麦克风进行语音输入
- 🤖 **AI 对话** - 基于 GPT 的智能英语对话
- 🔊 **语音合成** - AI 回复自动转为语音
- 👤 **数字人形象** - 阿里云万相数字人实时驱动
- 💬 **会话管理** - 支持多轮对话和历史记录
- 📱 **响应式设计** - 适配桌面和移动设备

## 技术栈

- **前端**: React + TypeScript + Vite
- **后端**: FastAPI (Python)
- **ASR**: 阿里云 DashScope - qwen-audio-3.1-asr-flash
- **LLM**: OpenAI GPT
- **TTS**: 阿里云 DashScope - qwen-audio-3.1-tts-flash
- **数字人**: 阿里云万相数字人云渲染音频驱动 WebSDK

## 完整链路

```
麦克风语音输入 → ASR语音识别 → LLM对话处理 → TTS语音合成 → 数字人形象驱动输出
```

## 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd english-speaking-coach
```

### 2. 配置环境变量

复制环境变量示例文件并配置您的 API Keys：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入以下配置：

```env
# DashScope API (用于 ASR 和 TTS)
DASHSCOPE_API_KEY=your-dashscope-api-key

# OpenAI API (用于 LLM)
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 3. 安装依赖

#### 使用启动脚本（推荐）

**Windows PowerShell:**
```powershell
.\start.ps1
```

**Linux/macOS:**
```bash
chmod +x start.sh
./start.sh
```

#### 手动安装

**后端:**
```bash
cd backend
python -m venv venv

# Windows
.\venv\Scripts\activate
# Linux/macOS
source venv/bin/activate

pip install -r requirements.txt
```

**前端:**
```bash
cd frontend
npm install
```

### 4. 启动应用

#### 开发模式

**后端:**
```bash
cd backend
# Windows
.\venv\Scripts\activate
# Linux/macOS
source venv/bin/activate

uvicorn main:app --reload
```

**前端:**
```bash
cd frontend
npm run dev
```

#### Docker 部署

```bash
docker-compose up --build
```

### 5. 访问应用

- 前端应用: http://localhost:5173
- 后端 API: http://localhost:8000
- API 文档: http://localhost:8000/docs

## API 接口

### 健康检查
```bash
GET /api/health
```

### 语音对话
```bash
POST /api/chat/voice
Content-Type: application/json

{
  "audio_data": "base64编码的音频数据",
  "session_id": "可选的会话ID"
}
```

### 文本对话
```bash
POST /api/chat/text
Content-Type: application/json

{
  "text": "对话文本",
  "session_id": "可选的会话ID",
  "generate_speech": true
}
```

### 初始化数字人
```bash
POST /api/avatar/init
Content-Type: application/json

{
  "user_id": "用户ID",
  "avatar_id": "可选的数字人ID"
}
```

### 获取聊天历史
```bash
GET /api/chat/history?session_id=xxx
```

## 项目结构

```
english-speaking-coach/
├── backend/
│   ├── main.py              # FastAPI 主应用
│   ├── config.py            # 配置文件
│   ├── requirements.txt     # Python 依赖
│   ├── api/
│   │   ├── models.py        # Pydantic 数据模型
│   │   └── routes.py        # API 路由
│   └── services/
│       ├── asr_service.py    # ASR 语音识别服务
│       ├── llm_service.py    # LLM 对话服务
│       └── tts_service.py    # TTS 语音合成服务
├── frontend/
│   ├── src/
│   │   ├── components/      # React 组件
│   │   ├── hooks/           # 自定义 Hooks
│   │   ├── services/        # API 服务
│   │   ├── store/            # 状态管理
│   │   ├── App.tsx          # 主应用组件
│   │   └── main.tsx         # 入口文件
│   ├── package.json
│   └── vite.config.ts
├── .env.example
├── docker-compose.yml
├── start.sh
├── start.ps1
├── test.mp4                # 演示视频
└── README.md
```

## 配置说明

### DashScope API

阿里云 DashScope 提供 ASR 和 TTS 服务：

- ASR 模型: `qwen-audio-3.1-asr-flash`
- TTS 模型: `qwen-audio-3.1-tts-flash`

获取 API Key: https://dashscope.console.aliyun.com/

### OpenAI API

用于 LLM 对话处理，推荐使用 GPT-4o-mini 或 GPT-4。

获取 API Key: https://platform.openai.com/api-keys

### 阿里云数字人

使用阿里云万相数字人云渲染服务，需要：

1. 开通阿里云数字人服务
2. 获取 App ID 和相关配置
3. 配置 RTC 参数

详细文档: https://help.aliyun.com/zh/avatar/

## 使用说明

1. **启动应用** - 按照上述步骤启动前后端服务
2. **初始化数字人** - 点击"初始化数字人"按钮
3. **开始对话** - 点击麦克风按钮开始语音输入
4. **查看回复** - AI 数字人会自动回复并驱动数字人播报

## 开发指南

### 前端开发

```bash
cd frontend
npm run dev    # 开发模式
npm run build  # 生产构建
```

### 后端开发

```bash
cd backend
uvicorn main:app --reload  # 开发模式
python main.py             # 生产模式
```

### API 文档

启动后端服务后访问 http://localhost:8000/docs 查看完整的 API 文档。

## 常见问题

### 1. 麦克风权限被拒绝

确保浏览器允许麦克风访问。对于本地开发，使用 `localhost` 域名。

### 2. CORS 错误

确保后端的 CORS 配置包含前端地址。默认配置:
- http://localhost:5173
- http://localhost:3000

### 3. API 调用失败

检查 `.env` 文件中的 API Keys 是否正确配置。

### 4. 数字人无法初始化

确保已正确配置阿里云数字人服务，并获取了有效的 RTC 参数。

## 许可证

MIT License

## 支持

如有问题，请提交 Issue 或联系开发者。
