require("dotenv").config();
const express = require("express");
const path = require("path");
const connectDB = require("./config/db");
const ClassModel = require("./models/Class");
const Student = require("./models/Student");
const Attendance = require("./models/Attendance");

// Import route modules
const createWebRoutes = require("./routes/web");
const createEnrollmentRoutes = require("./routes/enrollment");
const createAttendanceRoutes = require("./routes/attendance");
const createAPIRoutes = require("./routes/api");

const app = express();
const PORT = process.env.PORT || 3000;

connectDB();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// State management for enrollments
let pendingEnrollment = null;
let lastEnrollmentStatus = null;

// State getters and setters
const getPendingEnrollment = () => pendingEnrollment;
const getLastEnrollmentStatus = () => lastEnrollmentStatus;
const setPendingEnrollment = (value) => {
  pendingEnrollment = value;
};
const setLastEnrollmentStatus = (value) => {
  lastEnrollmentStatus = value;
};

// Import and use route modules
app.use(
  createWebRoutes(
    ClassModel,
    Student,
    Attendance,
    getPendingEnrollment,
    getLastEnrollmentStatus,
    setPendingEnrollment,
    setLastEnrollmentStatus,
  ),
);
app.use(
  createEnrollmentRoutes(
    ClassModel,
    Student,
    Attendance,
    getPendingEnrollment,
    getLastEnrollmentStatus,
    setPendingEnrollment,
    setLastEnrollmentStatus,
  ),
);
app.use(createAttendanceRoutes(Student, Attendance));
app.use(createAPIRoutes(ClassModel, Student));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
