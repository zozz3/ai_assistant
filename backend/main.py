"""
English Speaking Coach - FastAPI Main Application
"""
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from config import HOST, PORT, CORS_ORIGINS
from api.routes import router
from api.config_routes import router as config_router

# 加载 .env（如果存在），避免覆盖已有 shell 环境变量
_backend_dir = Path(__file__).parent.resolve()
_env_main = _backend_dir / ".env"
if _env_main.exists():
    load_dotenv(_env_main, override=False)
# 也读 avatar_agents/.env（向后兼容）
_env_agents = _backend_dir / "avatar_agents" / ".env"
if _env_agents.exists():
    load_dotenv(_env_agents, override=False)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="English Speaking Coach API",
    description="English Speaking Coach Backend API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(router)
app.include_router(config_router)


@app.on_event("startup")
async def startup_event():
    """Application startup event"""
    logger.info("=" * 50)
    logger.info("English Speaking Coach Backend Starting")
    logger.info(f"API docs: http://{HOST}:{PORT}/docs")
    logger.info("Avatar provider: Simli P2P (browser <-> Simli cloud, no SFU needed)")
    logger.info("=" * 50)


@app.on_event("shutdown")
async def shutdown_event():
    """Application shutdown event"""
    logger.info("Application shutting down")


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "message": "English Speaking Coach API",
        "version": "1.0.0",
        "docs": "/docs"
    }


@app.get("/debug/env")
async def debug_env():
    """Debug: 查看后端进程能拿到哪些关键环境变量（仅开发用）"""
    import os
    ak = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID", "")
    sk = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "")
    return {
        "ALIBABA_CLOUD_ACCESS_KEY_ID_set": bool(ak),
        "ALIBABA_CLOUD_ACCESS_KEY_ID_len": len(ak),
        "ALIBABA_CLOUD_ACCESS_KEY_ID_preview": ak[:8] + "..." if ak else "(empty)",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET_set": bool(sk),
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET_len": len(sk),
        "DASHSCOPE_API_KEY_set": bool(os.getenv("DASHSCOPE_API_KEY")),
        "DEEPSEEK_API_KEY_set": bool(os.getenv("DEEPSEEK_API_KEY")),
        "SIMLI_API_KEY_set": bool(os.getenv("SIMLI_API_KEY")),
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        reload=True,
        log_level="info"
    )
