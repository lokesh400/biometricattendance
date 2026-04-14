#include <Adafruit_Fingerprint.h>

// ESP32 UART2: RX=16, TX=17 (adjust if your wiring differs)
HardwareSerial fingerSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fingerSerial);

void waitForYes() {
  Serial.println("Type YES and press Enter to delete all templates:");

  String input = "";
  while (true) {
    while (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\n' || c == '\r') {
        input.trim();
        if (input == "YES") {
          return;
        }
        input = "";
        Serial.println("Confirmation failed. Type YES to continue.");
      } else {
        input += c;
      }
    }
    delay(10);
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println("R307 Clear All Templates");
  fingerSerial.begin(57600, SERIAL_8N1, 16, 17);
  finger.begin(57600);

  if (!finger.verifyPassword()) {
    Serial.println("Sensor not found or password verify failed.");
    while (true) {
      delay(1000);
    }
  }

  Serial.println("Sensor detected.");

  uint8_t p = finger.getTemplateCount();
  if (p == FINGERPRINT_OK) {
    Serial.print("Templates before clear: ");
    Serial.println(finger.templateCount);
  }

  waitForYes();

  p = finger.emptyDatabase();
  if (p == FINGERPRINT_OK) {
    Serial.println("All templates deleted successfully.");
  } else {
    Serial.print("Failed to clear database. Code: ");
    Serial.println(p);
  }

  p = finger.getTemplateCount();
  if (p == FINGERPRINT_OK) {
    Serial.print("Templates after clear: ");
    Serial.println(finger.templateCount);
  }

  Serial.println("Done.");
}

void loop() {
  delay(1000);
}
