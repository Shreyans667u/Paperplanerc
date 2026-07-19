# Paper Plane Party

A group votes on flight commands in real time (1 command per pilot per
round); majority wins and gets sent straight to your ESP32-S3 paper
airplane's servo board. Max 5 pilots per room, public or private.

## 1. Run the server

```bash
npm install
npm start
```

Server runs on `http://localhost:8080` (set `PORT` env var to change it).
The web client is served automatically from `/public`.

## 2. Open the web app

On your phone or laptop, go to `http://<your-computer-LAN-IP>:8080`.
Add it to your phone's home screen (Share → Add to Home Screen) so it
behaves like an installed app.

- **Create a room** — choose Public (listed in the lobby for anyone) or
  Private (share the 4-letter code yourself).
- **Join a room** — pick from the public list or enter a private code.
- **Vote** — tap one command per round. Once locked, you can't change
  it until the next round (one command at a time, as requested).
- Rounds run every 2 seconds — long enough to feel deliberate, short
  enough to stay exciting.

## 3. Flash the plane

Open `esp32_client/esp32_client.ino` in Arduino IDE:

1. Install libraries: `arduinoWebSockets`, `ArduinoJson`, `ESP32Servo`.
2. Set `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_HOST` (your computer's LAN
   IP), and `ROOM_CODE` (must match the room your pilots joined).
3. Wire the rudder/elevator servos and motor driver PWM per the pin
   constants at the top of the file — adjust to match your servo board.
4. Flash to the ESP32-S3. Once connected, the plane's status dot in
   the web app turns green.

Commands nudge the servos gradually (not full-deflection snaps) so
the plane flies realistically instead of jerking around.

## 4. Voice chat

This app is vote-only by design — no built-in mic/audio. Hop on a
Discord voice channel with your group while you fly so people can
call out strategy ("everyone vote right!") between rounds.

## Notes

- Private rooms are only joinable with the exact code — they're not
  listed in the public lobby.
- If nobody sends a command in a round, that round resolves as "no
  consensus" and the plane holds its last position.
- To deploy so friends can join remotely (not just on your WiFi),
  host `server.js` on any Node-friendly host (Render, Railway, a VPS)
  and point both the web app and the ESP32 at that public address.
