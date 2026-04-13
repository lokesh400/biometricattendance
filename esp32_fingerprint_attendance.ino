#include <WiFi.h>
#include <HTTPClient.h>
#include <Adafruit_Fingerprint.h>

HardwareSerial mySerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&mySerial);

const char *ssid = "Lokesh";
const char *password = "";

const char *attendanceUrl = "http://10.80.157.198:3000/api/attendance/mark";
const char *enrollmentNextUrl = "http://10.80.157.198:3000/api/device/enrollment/next";
const char *enrollmentResultUrl = "http://10.80.157.198:3000/api/device/enrollment/result";

#define TOUCH_PIN 4
#define BUZZER_PIN 5

unsigned long lastEnrollmentPollMs = 0;
unsigned long lastScanMs = 0;
const unsigned long scanDebounceMs = 1500;
const unsigned long enrollmentPollIntervalMs = 2000;
const unsigned long fingerWaitTimeoutMs = 12000;

unsigned long lastDiagnosticPrintMs = 0;
const unsigned long diagnosticIntervalMs = 5000;

void setup()
{
    Serial.begin(115200);
    mySerial.begin(57600, SERIAL_8N1, 16, 17);
    pinMode(TOUCH_PIN, INPUT_PULLUP);
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW); // Buzzer off initially

    WiFi.begin(ssid, password);
    Serial.print("Connecting WiFi");
    while (WiFi.status() != WL_CONNECTED)
    {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Connected!");

    finger.begin(57600);
    if (finger.verifyPassword())
    {
        Serial.println("Fingerprint sensor detected!");
    }
    else
    {
        Serial.println("Sensor not found!");
        while (true)
        {
            delay(1000);
        }
    }
}

void loop()
{
    printDiagnosticsIfNeeded();
    checkEnrollmentTask();
    captureAttendance();
    delay(200);
}

void printDiagnosticsIfNeeded()
{
    unsigned long now = millis();
    if (now - lastDiagnosticPrintMs < diagnosticIntervalMs)
    {
        return;
    }
    lastDiagnosticPrintMs = now;

    int touchState = digitalRead(TOUCH_PIN);
    int wifiStatus = WiFi.status();
    Serial.print("[DIAG] Touch PIN #4: ");
    Serial.print(touchState);
    Serial.print(" | WiFi: ");
    Serial.print(wifiStatus == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");
    Serial.println();
}

void beep(int count)
{
    // count=1: single beep
    // count=2: dual beep
    for (int i = 0; i < count; i++)
    {
        digitalWrite(BUZZER_PIN, HIGH);
        delay(200);
        digitalWrite(BUZZER_PIN, LOW);
        if (i < count - 1)
        {
            delay(100);
        }
    }
}

void captureAttendance()
{
    // Check if finger is on scanner (by trying to get image)
    int imageResult = finger.getImage();

    if (imageResult != FINGERPRINT_OK)
    {
        return; // No finger detected
    }

    unsigned long now = millis();
    if (now - lastScanMs < scanDebounceMs)
    {
        return; // Debounce: ignore rapid consecutive touches
    }
    lastScanMs = now;

    Serial.println("\n========== FINGER DETECTED ON SCANNER ==========");
    Serial.println("Processing fingerprint...");

    // Now process the image we already captured
    int tz = finger.image2Tz();
    if (tz != FINGERPRINT_OK)
    {
        Serial.print("[ERROR] image2Tz failed with code: ");
        Serial.println(tz);
        beep(2); // Dual beep on failure
        Serial.println("==============================================\n");
        return;
    }

    Serial.println("[SENSOR] Template created - searching database...");
    int search = finger.fingerSearch();

    if (search == FINGERPRINT_OK)
    {
        int id = finger.fingerID;
        Serial.print("✓ Fingerprint matched! ID: ");
        Serial.println(id);
        sendAttendance(id);
        beep(1); // Single beep on success
        Serial.println("Waiting for finger removal...");
        waitFingerRemoved();
        delay(500);
    }
    else
    {
        Serial.print("✗ Fingerprint not found in database. Code: ");
        Serial.println(search);
        beep(2); // Dual beep on failure
        waitFingerRemoved();
    }

    Serial.println("==============================================\n");
}

int attemptFingerprintCapture()
{
    unsigned long startTime = millis();
    const unsigned long timeoutMs = 8000;
    int dotCount = 0;

    while (millis() - startTime < timeoutMs)
    {
        int imageResult = finger.getImage();

        if (imageResult == FINGERPRINT_OK)
        {
            Serial.println("\n[SENSOR] Image captured - processing...");

            int tz = finger.image2Tz();
            if (tz != FINGERPRINT_OK)
            {
                Serial.print("[ERROR] image2Tz failed with code: ");
                Serial.println(tz);
                return -1;
            }

            Serial.println("[SENSOR] Template created - searching database...");

            int search = finger.fingerSearch();
            if (search == FINGERPRINT_OK)
            {
                Serial.print("[SUCCESS] Fingerprint ID found: ");
                Serial.println(finger.fingerID);
                return finger.fingerID;
            }
            else
            {
                Serial.print("[ERROR] Fingerprint not in database. Code: ");
                Serial.println(search);
                return -1;
            }
        }
        else if (imageResult == FINGERPRINT_NOFINGER)
        {
            if (dotCount % 10 == 0)
            {
                Serial.print(".");
            }
            dotCount++;
            delay(50);
            continue;
        }
        else
        {
            Serial.print("[ERROR] Sensor communication error code: ");
            Serial.println(imageResult);
            return -1;
        }
    }

    Serial.println("\n[ERROR] Timeout: No clear fingerprint captured in 8 seconds.");
    return -1;
}

void checkEnrollmentTask()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    unsigned long now = millis();
    if (now - lastEnrollmentPollMs < enrollmentPollIntervalMs)
    {
        return;
    }
    lastEnrollmentPollMs = now;

    HTTPClient http;
    http.begin(enrollmentNextUrl);
    int code = http.GET();
    if (code != 200)
    {
        http.end();
        return;
    }

    String body = http.getString();
    http.end();
    body.trim();

    if (body == "NONE")
    {
        return;
    }

    int p1 = body.indexOf('|');
    int p2 = body.indexOf('|', p1 + 1);
    int p3 = body.indexOf('|', p2 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0)
    {
        return;
    }

    String cmd = body.substring(0, p1);
    String requestId = body.substring(p1 + 1, p2);
    int fingerprintId = body.substring(p2 + 1, p3).toInt();

    if (cmd != "ENROLL" || fingerprintId <= 0)
    {
        return;
    }

    Serial.print("Enrollment request received. ID: ");
    Serial.println(fingerprintId);
    String enrollmentResult = enrollFingerprintWithReason(fingerprintId);
    bool ok = enrollmentResult == "captured";
    reportEnrollmentResult(requestId, ok, enrollmentResult);
}

int getFingerprintID()
{
    // Deprecated: use attemptFingerprintCapture() instead
    if (finger.getImage() != FINGERPRINT_OK)
        return -1;
    if (finger.image2Tz() != FINGERPRINT_OK)
        return -1;
    if (finger.fingerSearch() != FINGERPRINT_OK)
        return -1;

    Serial.print("Found ID: ");
    Serial.println(finger.fingerID);
    return finger.fingerID;
}

void sendAttendance(int id)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("WiFi Disconnected!");
        return;
    }

    HTTPClient http;
    String url = String(attendanceUrl) + "?id=" + String(id);
    http.begin(url);

    int httpResponseCode = http.GET();
    String response = http.getString();

    Serial.print("Server Response Code: ");
    Serial.println(httpResponseCode);
    Serial.print("Server Response: ");
    Serial.println(response);

    http.end();
}

bool captureImageAndConvert(uint8_t slot)
{
    unsigned long start = millis();
    while (true)
    {
        int p = finger.getImage();
        if (p == FINGERPRINT_OK)
        {
            int c = finger.image2Tz(slot);
            if (c != FINGERPRINT_OK)
            {
                Serial.print("image2Tz failed (slot ");
                Serial.print(slot);
                Serial.print(") code: ");
                Serial.println(c);
                return false;
            }
            return true;
        }

        if (p != FINGERPRINT_NOFINGER)
        {
            Serial.print("getImage error code: ");
            Serial.println(p);
        }

        if (millis() - start > fingerWaitTimeoutMs)
        {
            Serial.println("Timed out waiting for finger image");
            return false;
        }

        delay(50);
    }
}

void waitFingerRemoved()
{
    unsigned long start = millis();
    while (true)
    {
        int p = finger.getImage();
        if (p == FINGERPRINT_NOFINGER)
        {
            return;
        }

        if (millis() - start > fingerWaitTimeoutMs)
        {
            Serial.println("Timed out waiting finger removal");
            return;
        }

        delay(50);
    }
}

String enrollFingerprintWithReason(int id)
{
    int del = finger.deleteModel(id);
    if (del != FINGERPRINT_OK && del != FINGERPRINT_PACKETRECIEVEERR && del != FINGERPRINT_BADLOCATION)
    {
        Serial.print("deleteModel warning code: ");
        Serial.println(del);
    }

    Serial.println("Place finger for first scan...");
    if (!captureImageAndConvert(1))
    {
        Serial.println("First scan failed");
        beep(2); // Dual beep on failure
        return "first_scan_failed";
    }

    Serial.println("Remove finger...");
    waitFingerRemoved();
    delay(300);

    Serial.println("Place same finger again...");
    if (!captureImageAndConvert(2))
    {
        Serial.println("Second scan failed");
        beep(2); // Dual beep on failure
        return "second_scan_failed";
    }

    int create = finger.createModel();
    if (create != FINGERPRINT_OK)
    {
        Serial.print("Model creation failed, code: ");
        Serial.println(create);
        beep(2); // Dual beep on failure
        return "create_model_failed_" + String(create);
    }

    int store = finger.storeModel(id);
    if (store != FINGERPRINT_OK)
    {
        Serial.print("Model storage failed, code: ");
        Serial.println(store);
        beep(2); // Dual beep on failure
        return "store_model_failed_" + String(store);
    }

    Serial.println("Enrollment success");
    beep(1); // Single beep on success
    return "captured";
}

void reportEnrollmentResult(const String &requestId, bool success, const String &message)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    HTTPClient http;
    http.begin(enrollmentResultUrl);
    http.addHeader("Content-Type", "application/x-www-form-urlencoded");

    String payload = "requestId=" + requestId + "&success=" + String(success ? "1" : "0") + "&message=" + message;
    int code = http.POST(payload);
    String body = http.getString();

    Serial.print("Enrollment result code: ");
    Serial.println(code);
    Serial.print("Enrollment result body: ");
    Serial.println(body);

    http.end();
}
