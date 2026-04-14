#include <Adafruit_Fingerprint.h>

// ESP32 UART2: RX=16, TX=17 (adjust if your wiring differs)
HardwareSerial fingerSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fingerSerial);

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println("R307 Capacity Check");
  fingerSerial.begin(57600, SERIAL_8N1, 16, 17);
  finger.begin(57600);

  if (!finger.verifyPassword()) {
    Serial.println("Sensor not found or password verify failed.");
    while (true) {
      delay(1000);
    }
  }

  Serial.println("Sensor detected.");

  uint8_t p = finger.getParameters();
  if (p != FINGERPRINT_OK) {
    Serial.print("getParameters failed. Code: ");
    Serial.println(p);
  } else {
    Serial.print("Capacity: ");
    Serial.println(finger.capacity);
    Serial.print("Packet length: ");
    Serial.println(finger.packet_len);
    Serial.print("Baud rate: ");
    Serial.println(finger.baud_rate);
  }

  p = finger.getTemplateCount();
  if (p != FINGERPRINT_OK) {
    Serial.print("getTemplateCount failed. Code: ");
    Serial.println(p);
  } else {
    Serial.print("Templates currently stored: ");
    Serial.println(finger.templateCount);
  }

  Serial.println("Done.");
}

void loop() {
  delay(1000);
}
