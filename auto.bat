@echo off
setlocal

:: --- 配置部分 ---
set URL=http://localhost:3000
set "CHROME_EXE=chrome.exe"
:: 设置临时文件目录，用于隔离每个玩家的缓存
set "BASE_PROFILE_DIR=%TEMP%\DemonTrail_Test_Profiles"

:: --- 清理旧缓存 (可选) ---
:: 如果你想每次启动都是全新的“第一次加入”，保留下面这行。
:: 如果你想保留上次的 UUID，请注释掉下面这行 (在行首加 ::)
rd /s /q "%BASE_PROFILE_DIR%" 2>nul

echo 正在启动 6 个独立玩家窗口...

:: --- 计算窗口大小 (假设屏幕 1920x1080) ---
:: 宽度 640，高度 500，刚好一行放3个，两行放6个
set W=640
set H=500

:: --- 启动 6 个实例 ---
:: 参数说明：
:: --user-data-dir: 指定独立的用户目录，实现 LocalStorage 隔离
:: --window-size: 设定窗口大小
:: --window-position: 设定屏幕位置 (X,Y)
:: --app: 以应用模式启动 (没有地址栏，更像游戏)

:: 第一排 (1, 2, 3)
start "" "%CHROME_EXE%" --user-data-dir="%BASE_PROFILE_DIR%\P1" --no-first-run --window-size=%W%,%H% --window-position=0,0 --app=%URL%
timeout /t 1 >nul
start "" "%CHROME_EXE%" --user-data-dir="%BASE_PROFILE_DIR%\P2" --no-first-run --window-size=%W%,%H% --window-position=640,0 --app=%URL%
timeout /t 1 >nul
start "" "%CHROME_EXE%" --user-data-dir="%BASE_PROFILE_DIR%\P3" --no-first-run --window-size=%W%,%H% --window-position=1280,0 --app=%URL%
timeout /t 1 >nul

:: 第二排 (4, 5, 6) - Y轴向下移动 520像素
start "" "%CHROME_EXE%" --user-data-dir="%BASE_PROFILE_DIR%\P4" --no-first-run --window-size=%W%,%H% --window-position=0,520 --app=%URL%
timeout /t 1 >nul
start "" "%CHROME_EXE%" --user-data-dir="%BASE_PROFILE_DIR%\P5" --no-first-run --window-size=%W%,%H% --window-position=640,520 --app=%URL%
timeout /t 1 >nul
start "" "%CHROME_EXE%" --user-data-dir="%BASE_PROFILE_DIR%\P6" --no-first-run --window-size=%W%,%H% --window-position=1280,520 --app=%URL%

echo 启动完成！请查看屏幕。
pause