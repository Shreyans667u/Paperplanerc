/*
  Paper Plane Party — ESP32-S3 flight client
  ------------------------------------------
  Connects to the game server as the "plane," listens for the winning
  vote each round, and drives the servo board with realistic, gradual
  movement (no snapping — paper planes glide, they don't teleport).

  Libraries needed (Library Manager):
    - WebSockets by Markus Sattler (arduinoWebSockets)
    - ArduinoJson
    - ESP32Servo

  Wiring (adjust to your motor driver board):
    - Rudder servo signal -> RUDDER_PIN
    - Elevator servo signal -> ELEVATOR_PIN
    - Motor driver PWM input -> THROTTLE_PIN
*/

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ---------- Config ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "192.168.1.50";  // your server's LAN IP or domain
const uint16_t SERVER_PORT = 8080;
const char* ROOM_CODE     = "ABCD";          // room code shown in the web lobby

const int RUDDER_PIN   = 6;   // left/right
const int ELEVATOR_PIN = 7;   // up/down
const int THROTTLE_PIN = 8;   // motor driver PWM

// ---------- Flight state ----------
Servo rudder;
Servo elevator;

int rudderAngle   = 90;   // 0-180, 90 = centered
int elevatorAngle = 90;
int throttleValue = 0;    // 0-255

const int RUDDER_STEP   = 12;   // degrees nudged per winning vote (momentum, not snapping)
const int ELEVATOR_STEP = 10;
const int THROTTLE_STEP = 25;

const int RUDDER_MIN = 40,  RUDDER_MAX = 140;
const int ELEV_MIN   = 40,  ELEV_MAX   = 140;

WebSocketsClient webSocket;

void applyCommand(const String& cmd) {
  if (cmd == "left") {
    rudderAngle = constrain(rudderAngle - RUDDER_STEP, RUDDER_MIN, RUDDER_MAX);
  } else if (cmd == "right") {
    rudderAngle = constrain(rudderAngle + RUDDER_STEP, RUDDER_MIN, RUDDER_MAX);
  } else if (cmd == "up") {
    elevatorAngle = constrain(elevatorAngle - ELEVATOR_STEP, ELEV_MIN, ELEV_MAX);
  } else if (cmd == "down") {
    elevatorAngle = constrain(elevatorAngle + ELEVATOR_STEP, ELEV_MIN, ELEV_MAX);
  } else if (cmd == "throttle_up") {
    throttleValue = constrain(throttleValue + THROTTLE_STEP, 0, 255);
  } else if (cmd == "throttle_down") {
    throttleValue = constrain(throttleValue - THROTTLE_STEP, 0, 255);
  }

  rudder.write(rudderAngle);
  elevator.write(elevatorAngle);
  analogWrite(THROTTLE_PIN, throttleValue);

  Serial.printf("[CMD] %s -> rudder=%d elevator=%d throttle=%d\n",
                cmd.c_str(), rudderAngle, elevatorAngle, throttleValue);
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      Serial.println("[WS] Connected — registering as plane...");
      StaticJsonDocument<128> doc;
      doc["type"] = "register_plane";
      doc["code"] = ROOM_CODE;
      String out;
      serializeJson(doc, out);
      webSocket.sendTXT(out);
      break;
    }

    case WStype_TEXT: {
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) return;

      const char* msgType = doc["type"];
      if (msgType && strcmp(msgType, "command") == 0) {
        applyCommand(String((const char*)doc["command"]));
      } else if (msgType && strcmp(msgType, "plane_registered") == 0) {
        Serial.println("[WS] Plane registered with room.");
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected — will auto-retry.");
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);

  rudder.attach(RUDDER_PIN);
  elevator.attach(ELEVATOR_PIN);
  pinMode(THROTTLE_PIN, OUTPUT);
  rudder.write(rudderAngle);
  elevator.write(elevatorAngle);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());

  webSocket.begin(SERVER_HOST, SERVER_PORT, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
}

void loop() {
  webSocket.loop();
}
