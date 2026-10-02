@echo off
chcp 65001 >nul
echo ========================================
echo   Restart Frontend and Backend (Hot Reload)
echo ========================================
echo.

echo [1/4] Closing existing processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
echo   Done.
echo.

echo [2/4] Starting backend (uvicorn --reload)...
start "Backend" /MIN cmd /k "cd /d d:\Desktop\my_work\demo\backend && venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
timeout /t 6 >nul
echo   Backend starting...
echo.

echo [3/4] Starting frontend (vite HMR)...
start "Frontend" /MIN cmd /k "cd /d d:\Desktop\my_work\demo\frontend && npm run dev"
timeout /t 8 >nul
echo   Frontend starting...
echo.

echo [4/4] Verifying services...
curl -s http://localhost:8000/api/health >nul 2>&1 && echo   [OK] Backend on http://localhost:8000 || echo   [FAIL] Backend not responding
curl -s http://localhost:5173 >nul 2>&1 && echo   [OK] Frontend on http://localhost:5173 || echo   [FAIL] Frontend not responding
echo.

echo ========================================
echo   Hot reload is now active!
echo   - Edit files in backend/ -> uvicorn auto-reloads
echo   - Edit files in frontend/src/ -> Vite HMR instantly updates
echo ========================================
pause
