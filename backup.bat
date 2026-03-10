@echo off
set TIMESTAMP=%date:~-4%%date:~3,2%%date:~0,2%_%time:~0,2%%time:~3,2%
set TIMESTAMP=%TIMESTAMP: =0%
set ZIPNAME=Mobius_Vercel_backup_%TIMESTAMP%.zip

echo Creating backup: %ZIPNAME%

powershell -Command "Compress-Archive -Force -Path @('ask.js','package.json','vercel.json','README.md','service-worker.js','index.html','commands.js','google_api.js','actions.js','favicon.ico','login.html','manifest.json','mobius-logo.png','api','help') -DestinationPath '%ZIPNAME%'"

echo Done: %ZIPNAME%
pause
