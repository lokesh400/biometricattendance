#include <WiFi.h>
#include <HTTPClient.h>
#include <Adafruit_Fingerprint.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

HardwareSerial mySerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&mySerial);

const char *ssid = "Lokesh";
const char *password = "";

const char *attendanceUrl = "http://10.185.57.198:3000/api/attendance/mark";
const char *enrollmentNextUrl = "http://10.185.57.198:3000/api/device/enrollment/next";
const char *enrollmentResultUrl = "http://10.185.57.198:3000/api/device/enrollment/result";
const char *migrationNextUrl = "http://10.185.57.198:3000/api/device/migration/next";
const char *migrationResultUrl = "http://10.185.57.198:3000/api/device/migration/result";
const char *deleteNextUrl = "http://10.185.57.198:3000/api/device/delete/next";
const char *deleteResultUrl = "http://10.185.57.198:3000/api/device/delete/result";
const char *sensorClearNextUrl = "http://10.185.57.198:3000/api/device/sensor/clear/next";
const char *sensorClearResultUrl = "http://10.185.57.198:3000/api/device/sensor/clear/result";

#define TOUCH_PIN 4
#define BUZZER_PIN 5

unsigned long lastEnrollmentPollMs = 0;
unsigned long lastMigrationPollMs = 0;
unsigned long lastDeletePollMs = 0;
unsigned long lastSensorClearPollMs = 0;
unsigned long lastScanMs = 0;
const unsigned long scanDebounceMs = 700;
const unsigned long enrollmentPollIntervalMs = 3000;
const unsigned long migrationPollIntervalMs = 3000;
const unsigned long deletePollIntervalMs = 2500;
const unsigned long sensorClearPollIntervalMs = 2500;
const unsigned long fingerWaitTimeoutMs = 12000;
const uint16_t httpPollTimeoutMs = 700;
const uint16_t httpPostTimeoutMs = 1200;
const unsigned long wifiReconnectIntervalMs = 10000;
const unsigned long sensorHealthCheckIntervalMs = 15000;
const int sensorErrorRecoverThreshold = 6;

unsigned long lastDiagnosticPrintMs = 0;
const unsigned long diagnosticIntervalMs = 5000;
unsigned long lastWifiReconnectAttemptMs = 0;
unsigned long lastSensorHealthCheckMs = 0;
int sensorConsecutiveErrors = 0;

LiquidCrystal_I2C lcd(0x27, 16, 2);

struct AttendanceResult
{
    bool transportOk;
    bool apiOk;
    String studentName;
    String eventType;
    String message;
};

void lcdShow(const String &line1, const String &line2)
{
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(line1.substring(0, 16));
    lcd.setCursor(0, 1);
    lcd.print(line2.substring(0, 16));
}

void showReady()
{
    lcdShow("Ready", "Scan finger");
}

String getJsonStringValue(const String &json, const String &key)
{
    String needle = "\"" + key + "\":\"";
    int start = json.indexOf(needle);
    if (start < 0)
    {
        return "";
    }

    start += needle.length();
    int end = json.indexOf('"', start);
    if (end < 0)
    {
        return "";
    }

    return json.substring(start, end);
}

/**
 * Parse error message from server response and create suitable LCD text
 * Maps server error messages to short LCD-friendly text (max 16 chars)
 */
String parseErrorMessage(const String &message, bool transportOk)
{
    String msg = message;
    msg.trim();
    String msgLower = msg;
    msgLower.toLowerCase();

    // Prefer server-provided business error messages whenever present.
    if (msg.length() > 0) {
        // Map exact server messages to short LCD text (max 16 chars)
        if (msgLower.indexOf("attendance already completed") >= 0 ||
            msgLower.indexOf("already punched out") >= 0 ||
            msgLower.indexOf("punch out already marked") >= 0) {
            return "Already OUT";
        }
        if (msgLower.indexOf("punch in already marked") >= 0) {
            return "IN marked today";
        }
        if (msgLower.indexOf("already punched in") >= 0) {
            return "Already IN";
        }
        if (msgLower.indexOf("cannot punch out before punch in") >= 0) {
            return "No IN yet";
        }
        if (msgLower.indexOf("already exists") >= 0) {
            return "Roll exists";
        }
        if (msgLower.indexOf("not found") >= 0) {
            return "Not enrolled";
        }
        if (msgLower.indexOf("in progress") >= 0) {
            return "In progress";
        }
        if (msgLower.indexOf("no match") >= 0) {
            return "No match";
        }
        if (msgLower.indexOf("error") >= 0 || msgLower.indexOf("failed") >= 0) {
            return "Error";
        }

        // Default: return shortened server message (first 14 chars to fit LCD)
        if (msg.length() > 14) {
            return msg.substring(0, 14);
        }
        return msg;
    }

    // No message available: then use transport state.
    if (!transportOk) {
        return "Server offline";
    }

    return "Server rejected";
}

void setup()
{
    Serial.begin(115200);
    Wire.begin(21, 22);
    lcd.init();
    lcd.backlight();
    lcdShow("Biometric", "Booting...");
    mySerial.begin(57600, SERIAL_8N1, 16, 17);
    pinMode(TOUCH_PIN, INPUT_PULLUP);
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW); // Buzzer off initially

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.begin(ssid, password);
    Serial.print("Connecting WiFi");
    lcdShow("WiFi", "Connecting...");
    while (WiFi.status() != WL_CONNECTED)
    {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Connected!");
    lcdShow("WiFi", "Connected");

    finger.begin(57600);
    if (finger.verifyPassword())
    {
        Serial.println("Fingerprint sensor detected!");
        showReady();
    }
    else
    {
        Serial.println("Sensor not found!");
        lcdShow("Sensor Error", "Not found");
        while (true)
        {
            delay(1000);
        }
    }
}

void loop()
{
    ensureWiFiConnected();
    checkFingerprintHealth();

    // Keep scan path first so attendance stays responsive even during network hiccups.
    captureAttendance();
    printDiagnosticsIfNeeded();
    checkEnrollmentTask();
    checkMigrationTask();
    checkDeleteTask();
    checkSensorClearTask();
    delay(25);
}

void ensureWiFiConnected()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        return;
    }

    unsigned long now = millis();
    if (now - lastWifiReconnectAttemptMs < wifiReconnectIntervalMs)
    {
        return;
    }
    lastWifiReconnectAttemptMs = now;

    Serial.println("[WIFI] Disconnected. Attempting reconnect...");
    WiFi.reconnect();
}

void recoverFingerprintSensor(const char *reason)
{
    Serial.print("[SENSOR] Recovering sensor. Reason: ");
    Serial.println(reason);
    lcdShow("Sensor recover", "Please wait");

    mySerial.end();
    delay(120);
    mySerial.begin(57600, SERIAL_8N1, 16, 17);
    finger.begin(57600);

    if (finger.verifyPassword())
    {
        sensorConsecutiveErrors = 0;
        Serial.println("[SENSOR] Recovery success.");
        showReady();
        return;
    }

    Serial.println("[SENSOR] Recovery failed.");
    lcdShow("Sensor error", "Check wiring");
}

void noteSensorError(const char *context, int code)
{
    sensorConsecutiveErrors++;
    Serial.print("[SENSOR] ");
    Serial.print(context);
    Serial.print(" error code: ");
    Serial.print(code);
    Serial.print(" | streak: ");
    Serial.println(sensorConsecutiveErrors);

    if (sensorConsecutiveErrors >= sensorErrorRecoverThreshold)
    {
        recoverFingerprintSensor("repeated sensor errors");
    }
}

void clearSensorErrorStreak()
{
    sensorConsecutiveErrors = 0;
}

void checkFingerprintHealth()
{
    unsigned long now = millis();
    if (now - lastSensorHealthCheckMs < sensorHealthCheckIntervalMs)
    {
        return;
    }
    lastSensorHealthCheckMs = now;

    if (finger.verifyPassword())
    {
        return;
    }

    noteSensorError("verifyPassword", -1);
}

void checkSensorClearTask()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    unsigned long now = millis();
    if (now - lastSensorClearPollMs < sensorClearPollIntervalMs)
    {
        return;
    }
    lastSensorClearPollMs = now;

    HTTPClient http;
    http.begin(sensorClearNextUrl);
    http.setTimeout(httpPollTimeoutMs);
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
    if (p1 < 0)
    {
        return;
    }

    String cmd = body.substring(0, p1);
    String requestId = body.substring(p1 + 1);
    if (cmd != "CLEAR_SENSOR" || requestId.length() == 0)
    {
        return;
    }

    lcdShow("Sensor clear", "In progress");
    int clearCode = finger.emptyDatabase();
    bool success = clearCode == FINGERPRINT_OK;
    String message = success ? "cleared" : ("clear_failed_" + String(clearCode));

    if (success)
    {
        lcdShow("Sensor clear", "Done");
        delay(250);
        showReady();
    }
    else
    {
        lcdShow("Sensor clear", "Failed");
    }

    HTTPClient postHttp;
    postHttp.begin(sensorClearResultUrl);
    postHttp.addHeader("Content-Type", "application/json");
    postHttp.setTimeout(httpPostTimeoutMs);

    String payload = "{";
    payload += "\"requestId\":\"" + requestId + "\",";
    payload += "\"success\":" + String(success ? "true" : "false") + ",";
    payload += "\"message\":\"" + message + "\"";
    payload += "}";

    int postCode = postHttp.POST(payload);
    String postBody = postHttp.getString();
    Serial.print("Sensor clear result code: ");
    Serial.println(postCode);
    Serial.print("Sensor clear result body: ");
    Serial.println(postBody);
    postHttp.end();
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
    Serial.print(" | SensorErrStreak: ");
    Serial.print(sensorConsecutiveErrors);
    Serial.println();
}

void beep(int count)
{
    // count=1: single beep
    // count=2: dual beep
    for (int i = 0; i < count; i++)
    {
        digitalWrite(BUZZER_PIN, HIGH);
        delay(80);
        digitalWrite(BUZZER_PIN, LOW);
        if (i < count - 1)
        {
            delay(60);
        }
    }
}

void captureAttendance()
{
    // Check if finger is on scanner (by trying to get image)
    int imageResult = finger.getImage();

    if (imageResult != FINGERPRINT_OK)
    {
        if (imageResult != FINGERPRINT_NOFINGER)
        {
            noteSensorError("getImage", imageResult);
        }
        return; // No finger detected
    }

    clearSensorErrorStreak();

    unsigned long now = millis();
    if (now - lastScanMs < scanDebounceMs)
    {
        return; // Debounce: ignore rapid consecutive touches
    }
    lastScanMs = now;

    Serial.println("\n========== FINGER DETECTED ON SCANNER ==========");
    Serial.println("Processing fingerprint...");
    lcdShow("Finger detected", "Processing...");

    // Now process the image we already captured
    int tz = finger.image2Tz();
    if (tz != FINGERPRINT_OK)
    {
        Serial.print("[ERROR] image2Tz failed with code: ");
        Serial.println(tz);
        noteSensorError("image2Tz", tz);
        beep(2); // Dual beep on failure
        Serial.println("==============================================\n");
        return;
    }

    Serial.println("[SENSOR] Template created - searching database...");
    int search = finger.fingerSearch();

    if (search == FINGERPRINT_OK)
    {
        clearSensorErrorStreak();
        int id = finger.fingerID;
        Serial.print("✓ Fingerprint matched! ID: ");
        Serial.println(id);
        AttendanceResult attendanceResult = sendAttendance(id);
        bool hasValidEvent = (attendanceResult.eventType == "IN" || attendanceResult.eventType == "OUT");
        if (attendanceResult.transportOk && attendanceResult.apiOk && hasValidEvent)
        {
            String line1 = attendanceResult.studentName.length() > 0 ? attendanceResult.studentName : "Attendance";
            String line2 = attendanceResult.eventType == "OUT" ? "Punch OUT" : "Punch IN";
            lcdShow(line1, line2);
            beep(1); // Single beep on success
        }
        else
        {
            // Parse the error message from server response
            String failLine2 = parseErrorMessage(attendanceResult.message, attendanceResult.transportOk);
            lcdShow("Attendance failed", failLine2);
            beep(2); // Dual beep on failure
            Serial.print("Attendance rejected: ");
            Serial.println(attendanceResult.message);
        }

        Serial.println("Waiting for finger removal...");
        waitFingerRemoved();
        delay(120);
        showReady();
    }
    else
    {
        Serial.print("✗ Fingerprint not found in database. Code: ");
        Serial.println(search);
        lcdShow("No match", "Try again");
        beep(2); // Dual beep on failure
        waitFingerRemoved();
        delay(80);
        showReady();
    }

    Serial.println("==============================================\n");
}

void checkDeleteTask()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    unsigned long now = millis();
    if (now - lastDeletePollMs < deletePollIntervalMs)
    {
        return;
    }
    lastDeletePollMs = now;

    HTTPClient http;
    http.begin(deleteNextUrl);
    http.setTimeout(httpPollTimeoutMs);
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
    int p4 = body.indexOf('|', p3 + 1);
    if (p1 < 0 || p2 < 0)
    {
        return;
    }

    String cmd = body.substring(0, p1);
    String requestId = body.substring(p1 + 1, p2);
    int fingerprintId = 0;
    String studentName = "";
    String rollNumber = "";
    if (p3 < 0)
    {
        fingerprintId = body.substring(p2 + 1).toInt();
    }
    else
    {
        fingerprintId = body.substring(p2 + 1, p3).toInt();
        if (p4 < 0)
        {
            studentName = body.substring(p3 + 1);
        }
        else
        {
            studentName = body.substring(p3 + 1, p4);
            rollNumber = body.substring(p4 + 1);
        }
    }

    if (cmd != "DELETE" || fingerprintId <= 0)
    {
        return;
    }

    String label = studentName.length() > 0 ? studentName : ("ID " + String(fingerprintId));
    lcdShow("Deleting", label);
    if (rollNumber.length() > 0)
    {
        Serial.print("Delete roll: ");
        Serial.println(rollNumber);
    }
    int delCode = finger.deleteModel(fingerprintId);
    bool ok = (delCode == FINGERPRINT_OK || delCode == FINGERPRINT_BADLOCATION);
    String msg = ok ? "deleted" : ("delete_failed_" + String(delCode));
    if (ok)
    {
        lcdShow("Deleted", label);
        delay(250);
        showReady();
    }
    else
    {
        lcdShow("Delete failed", label);
    }

    HTTPClient postHttp;
    postHttp.begin(deleteResultUrl);
    postHttp.addHeader("Content-Type", "application/json");
    postHttp.setTimeout(httpPostTimeoutMs);

    String payload = "{";
    payload += "\"requestId\":\"" + requestId + "\",";
    payload += "\"success\":" + String(ok ? "true" : "false") + ",";
    payload += "\"message\":\"" + msg + "\"";
    payload += "}";

    int postCode = postHttp.POST(payload);
    String postBody = postHttp.getString();
    Serial.print("Delete result code: ");
    Serial.println(postCode);
    Serial.print("Delete result body: ");
    Serial.println(postBody);
    postHttp.end();
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
                noteSensorError("fingerSearch", search);
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
            noteSensorError("attemptFingerprintCapture/getImage", imageResult);
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
    http.setTimeout(httpPollTimeoutMs);
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
    int p4 = body.indexOf('|', p3 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0 || p4 < 0)
    {
        return;
    }

    String cmd = body.substring(0, p1);
    String requestId = body.substring(p1 + 1, p2);
    int fingerprintId = body.substring(p2 + 1, p3).toInt();
    String rollNumber = body.substring(p3 + 1, p4);
    String studentName = body.substring(p4 + 1);

    if (cmd != "ENROLL" || fingerprintId <= 0)
    {
        return;
    }

    Serial.print("Enrollment request received. ID: ");
    Serial.println(fingerprintId);
    lcdShow("Enroll:", studentName);
    if (rollNumber.length() > 0)
    {
        Serial.print("Roll: ");
        Serial.println(rollNumber);
    }
    String enrollmentResult = enrollFingerprintWithReason(fingerprintId);
    bool ok = enrollmentResult == "captured";
    String templateHex = ok ? captureStoredFingerprintTemplateHex((uint16_t)fingerprintId) : "";
    if (ok)
    {
        lcdShow("Enroll saved", studentName);
        delay(250);
        showReady();
    }
    else
    {
        lcdShow("Enroll failed", studentName);
    }
    reportEnrollmentResult(requestId, ok, enrollmentResult, templateHex);
}

void checkMigrationTask()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    unsigned long now = millis();
    if (now - lastMigrationPollMs < migrationPollIntervalMs)
    {
        return;
    }
    lastMigrationPollMs = now;

    HTTPClient http;
    http.begin(migrationNextUrl);
    http.setTimeout(httpPollTimeoutMs);
    int code = http.GET();
    if (code != 200)
    {
        http.end();
        return;
    }

    String body = http.getString();
    http.end();
    body.trim();

    if (body == "NONE" || body == "WAIT")
    {
        return;
    }

    int p1 = body.indexOf('|');
    int p2 = body.indexOf('|', p1 + 1);
    if (p1 < 0 || p2 < 0)
    {
        return;
    }

    String cmd = body.substring(0, p1);
    String requestId = body.substring(p1 + 1, p2);
    int fingerprintId = body.substring(p2 + 1).toInt();

    if (cmd == "EXPORT")
    {
        if (fingerprintId <= 0)
        {
            return;
        }

        String templateHex = captureStoredFingerprintTemplateHex((uint16_t)fingerprintId);
        bool success = templateHex.length() > 0;
        String message = success ? "exported" : "export_failed";
        reportMigrationResult(requestId, "export", fingerprintId, success, message, templateHex);
        return;
    }

    if (cmd == "CLEAR")
    {
        int clearCode = finger.emptyDatabase();
        bool success = clearCode == FINGERPRINT_OK;
        String message = success ? "cleared" : ("clear_failed_" + String(clearCode));
        reportMigrationResult(requestId, "clear", 0, success, message, "");
        return;
    }
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

AttendanceResult sendAttendance(int id)
{
    AttendanceResult result;
    result.transportOk = false;
    result.apiOk = false;
    result.studentName = "";
    result.eventType = "";
    result.message = "";

    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("WiFi Disconnected!");
        result.message = "wifi_disconnected";
        return result;
    }

    HTTPClient http;
    String url = String(attendanceUrl) + "?id=" + String(id);
    http.begin(url);
    http.setTimeout(httpPostTimeoutMs);

    int httpResponseCode = http.GET();
    String response = http.getString();

    Serial.print("Server Response Code: ");
    Serial.println(httpResponseCode);
    Serial.print("Server Response: ");
    Serial.println(response);

    http.end();

    // transportOk means server reachable (any HTTP response), not business success.
    result.transportOk = (httpResponseCode > 0);
    result.apiOk = (response.indexOf("\"ok\":true") >= 0);
    result.message = getJsonStringValue(response, "message");
    result.studentName = getJsonStringValue(response, "name");
    result.eventType = getJsonStringValue(response, "eventType");

    return result;
}

bool captureImageAndConvert(uint8_t slot)
{
    unsigned long start = millis();
    while (true)
    {
        int p = finger.getImage();
        if (p == FINGERPRINT_OK)
        {
            clearSensorErrorStreak();
            int c = finger.image2Tz(slot);
            if (c != FINGERPRINT_OK)
            {
                Serial.print("image2Tz failed (slot ");
                Serial.print(slot);
                Serial.print(") code: ");
                Serial.println(c);
                noteSensorError("captureImageAndConvert/image2Tz", c);
                return false;
            }
            return true;
        }

        if (p != FINGERPRINT_NOFINGER)
        {
            Serial.print("getImage error code: ");
            Serial.println(p);
            noteSensorError("captureImageAndConvert/getImage", p);
        }

        if (millis() - start > fingerWaitTimeoutMs)
        {
            Serial.println("Timed out waiting for finger image");
            return false;
        }

        delay(50);
    }
}

String bytesToHex(const uint8_t *data, size_t length)
{
    static const char hexDigits[] = "0123456789ABCDEF";
    String hex;
    hex.reserve(length * 2);

    for (size_t i = 0; i < length; i++)
    {
        hex += hexDigits[(data[i] >> 4) & 0x0F];
        hex += hexDigits[data[i] & 0x0F];
    }

    return hex;
}

String captureStoredFingerprintTemplateHex(uint16_t modelId)
{
    if (finger.loadModel(modelId) != FINGERPRINT_OK)
    {
        Serial.println("Failed to load stored model for backup capture");
        return "";
    }

    if (finger.getModel() != FINGERPRINT_OK)
    {
        Serial.println("Failed to start template transfer from sensor");
        return "";
    }

    uint8_t bytesReceived[534];
    memset(bytesReceived, 0xFF, sizeof(bytesReceived));

    unsigned long startTime = millis();
    int bytesRead = 0;
    while (bytesRead < (int)sizeof(bytesReceived) && (millis() - startTime) < 20000)
    {
        if (mySerial.available())
        {
            bytesReceived[bytesRead++] = mySerial.read();
        }
        else
        {
            delay(1);
        }
    }

    if (bytesRead != (int)sizeof(bytesReceived))
    {
        Serial.print("Template capture incomplete. Bytes read: ");
        Serial.println(bytesRead);
        return "";
    }

    uint8_t fingerTemplate[512];
    memset(fingerTemplate, 0xFF, sizeof(fingerTemplate));

    int inputIndex = 9;
    memcpy(fingerTemplate, bytesReceived + inputIndex, 256);
    inputIndex += 256 + 2 + 9;
    memcpy(fingerTemplate + 256, bytesReceived + inputIndex, 256);

    return bytesToHex(fingerTemplate, sizeof(fingerTemplate));
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

void reportEnrollmentResult(const String &requestId, bool success, const String &message, const String &templateHex)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    HTTPClient http;
    http.begin(enrollmentResultUrl);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(httpPostTimeoutMs);

    String payload = "{";
    payload += "\"requestId\":\"" + requestId + "\",";
    payload += "\"success\":" + String(success ? "true" : "false") + ",";
    payload += "\"message\":\"" + message + "\",";
    payload += "\"templateHex\":\"" + templateHex + "\"";
    payload += "}";

    int code = http.POST(payload);
    String body = http.getString();

    Serial.print("Enrollment result code: ");
    Serial.println(code);
    Serial.print("Enrollment result body: ");
    Serial.println(body);

    http.end();
}

void reportMigrationResult(const String &requestId, const String &action, int fingerprintId, bool success, const String &message, const String &templateHex)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    HTTPClient http;
    http.begin(migrationResultUrl);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(httpPostTimeoutMs);

    String payload = "{";
    payload += "\"requestId\":\"" + requestId + "\",";
    payload += "\"action\":\"" + action + "\",";
    payload += "\"fingerprintId\":" + String(fingerprintId) + ",";
    payload += "\"success\":" + String(success ? "true" : "false") + ",";
    payload += "\"message\":\"" + message + "\",";
    payload += "\"templateHex\":\"" + templateHex + "\"";
    payload += "}";

    int code = http.POST(payload);
    String body = http.getString();

    Serial.print("Migration result code: ");
    Serial.println(code);
    Serial.print("Migration result body: ");
    Serial.println(body);

    http.end();
}
