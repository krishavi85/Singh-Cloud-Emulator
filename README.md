# Singh Cloud Emulator

Singh Cloud Emulator is a self-hosted browser dashboard for viewing and interacting with an Android emulator or an ADB-connected Android device.

## MVP features

- Detect connected Android devices and emulators
- Display the Android screen in a browser
- Mouse, touch, swipe, keyboard, Home, Back, Recents, and Power controls
- Rotate the Android display
- Upload and install APK files on a selected development device
- Launch an installed application by package name
- Start and stop a configured Android Virtual Device
- WebSocket activity and status events

## Requirements

- Node.js 20 or newer
- Android SDK Platform Tools
- Android Emulator with at least one configured AVD
- Hardware virtualization enabled

## Installation

```bash
git clone https://github.com/krishavi85/Singh-Cloud-Emulator.git
cd Singh-Cloud-Emulator
npm install
cp .env.example .env
npm start
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Open `http://127.0.0.1:8080`.

## Windows environment example

```env
PORT=8080
HOST=127.0.0.1
ADB_PATH=C:/Users/YOUR_NAME/AppData/Local/Android/Sdk/platform-tools/adb.exe
EMULATOR_PATH=C:/Users/YOUR_NAME/AppData/Local/Android/Sdk/emulator/emulator.exe
ANDROID_AVD=Pixel_8_API_35
STREAM_FPS=4
MAX_APK_SIZE_MB=500
AUTO_START_AVD=false
```

## Local usage

1. Open Android Studio and Device Manager.
2. Start an Android Virtual Device.
3. Run `npm start`.
4. Open the dashboard.
5. Select the connected emulator.

## Security

This MVP is designed for local development or a protected private network. Before exposing it publicly, add authentication, HTTPS, per-user isolation, rate limits, APK scanning, audit logging, upload retention rules, and container or virtual-machine sandboxing.

## Roadmap

- Low-latency WebRTC video and audio
- User accounts and session scheduling
- PostgreSQL and Redis persistence
- Isolated cloud emulator workers
- Shareable sessions and embedded previews
- Test automation and usage controls

## License

MIT
