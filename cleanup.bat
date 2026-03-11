@echo off
cd /d C:\Users\263350F\Mobius\Mobius_Factory

echo Removing user-facing UI files...
del /f /q index.html
del /f /q login.html
del /f /q signup.html
del /f /q favicon.ico
del /f /q mobius-logo.png
del /f /q service-worker.js
del /f /q manifest.json

echo Removing Mobius-specific JS...
del /f /q actions.js
del /f /q commands.js
del /f /q google_api.js

echo Removing help folder...
rmdir /s /q help

echo Removing documents folder...
rmdir /s /q documents

echo Removing old backup and repomix files...
del /f /q Mobius_Vercel_backup_202602Th_1508.zip
del /f /q repomix-output.xml

echo Removing Mobius server...
del /f /q server.js

echo Removing unneeded API folders and files...
rmdir /s /q api\focus
rmdir /s /q api\google
rmdir /s /q api\sync
rmdir /s /q api\services
rmdir /s /q api\auth\dropbox
rmdir /s /q api\auth\google
rmdir /s /q api\auth\user
del /f /q api\upload.js
del /f /q api\data.js
del /f /q "api\auth\[service].js"
del /f /q "api\query\[action].js"

echo Done. Remaining files:
dir /b /s | findstr /v "node_modules" | findstr /v "\.git"

pause