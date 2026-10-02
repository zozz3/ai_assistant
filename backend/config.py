"""
英语口语陪练应用 - FastAPI后端配置
"""
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# DashScope配置
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"

# OpenAI配置
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")

# 服务器配置
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# CORS配置
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")

# 阿里云万相数字人配置
AVATAR_APP_ID = os.getenv("AVATAR_APP_ID", "")
AVATAR_SERVER_USER_ID = os.getenv("AVATAR_SERVER_USER_ID", "")

# TTS默认音色
DEFAULT_TTS_VOICE = "af_zhixiaobai_oral"  # 中文口语女声
# 可选英文音色：en_us_male_mix, en_us_female_clarity等

# ASR配置
ASR_MODEL = "qwen-audio-3.1-asr-flash"
ASR_FORMAT = "wav"
ASR_SAMPLE_RATE = 16000

# TTS配置
TTS_MODEL = "qwen-audio-3.1-tts-flash"
TTS_FORMAT = "mp3"
TTS_SAMPLE_RATE = 48000

# LLM配置
LLM_MODEL = "gpt-4o-mini"
LLM_TEMPERATURE = 0.7
LLM_MAX_TOKENS = 500

# 英语口语教练提示词
ENGLISH_COACH_PROMPT = """You are an experienced English speaking coach helping a learner practice their spoken English. 

Your role:
1. Engage in natural, conversational dialogue
2. Provide gentle corrections when needed
3. Encourage the learner and build confidence
4. Use simple to moderate vocabulary appropriate for learners
5. Speak in a friendly, supportive tone

Guidelines:
- Keep responses concise and natural (2-4 sentences for most responses)
- Ask follow-up questions to encourage continued conversation
- Gently correct pronunciation or grammar errors if the user makes mistakes
- Provide positive reinforcement
- Adapt your speaking level to match the user's level

Current topic: General conversation to help practice English.
"""
