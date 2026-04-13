# Biometric Attendance System

A local attendance system built with **Node.js**, **EJS**, and **MongoDB** for an ESP32 fingerprint scanner.

## Features

- Register students with roll number and name
- Auto-assign fingerprint ID on registration request
- Student is saved only after ESP32 enrollment success callback
- Auto punch in / punch out based on the latest attendance event for the day
- ESP32 API endpoint for fingerprint scan results
- Simple dark UI for local use

## Tech Stack

- Node.js
- Express
- EJS
- MongoDB + Mongoose

## Setup

1. Install dependencies:
   - `npm install`
2. Create a `.env` file (example below)
3. Start MongoDB locally
4. Run the app:
   - `npm run dev`
   - or `npm start`

Example `.env`:

`PORT=3000`

`MONGODB_URI=mongodb://127.0.0.1:27017/biometric_attendance`

## Environment

- `PORT` defaults to `3000`
- `MONGODB_URI` defaults to `mongodb://127.0.0.1:27017/biometric_attendance`

## ESP32 Endpoint

Use this endpoint after fingerprint matching:

- `GET /api/attendance/mark?id=<fingerprint_id>`

For enrollment workflow (handled by ESP32 firmware):

- `GET /api/device/enrollment/next`
- `POST /api/device/enrollment/result`

Example response automatically marks:

- `IN` when the student has no event today or the latest event is `OUT`
- `OUT` when the latest event for that student today is `IN`

## Web Routes

- `GET /` - dashboard
- `POST /students` - create pending enrollment request
- `GET /api/students` - JSON list of students
- `GET /api/attendance` - JSON attendance log
- `POST /api/attendance/punch-in` - manual punch in
- `POST /api/attendance/punch-out` - manual punch out

## Enrollment Flow

1. Submit student name and roll number from web form.
2. Server creates one pending enrollment task with a fingerprint ID.
3. ESP32 polls `GET /api/device/enrollment/next` and receives the task.
4. ESP32 captures the same finger twice and stores template in sensor memory.
5. ESP32 posts success/failure to `POST /api/device/enrollment/result`.
6. Server saves the student record only on success.
# biometricattendance
