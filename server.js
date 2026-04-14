require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo").default;
const passport = require("passport");
const connectDB = require("./config/db");
const ClassModel = require("./models/Class");
const Student = require("./models/Student");
const Attendance = require("./models/Attendance");
const Admin = require("./models/Admin");

// Import route modules
const createWebRoutes = require("./routes/web");
const createEnrollmentRoutes = require("./routes/enrollment");
const createAttendanceRoutes = require("./routes/attendance");
const createAPIRoutes = require("./routes/api");
const createMigrationRoutes = require("./routes/migration");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "biometric-attendance-session-secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: "sessions",
      ttl: 60 * 60 * 24,
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24,
      httpOnly: true,
      sameSite: "lax",
    },
  }),
);

passport.use(Admin.createStrategy());
passport.serializeUser(Admin.serializeUser());
passport.deserializeUser(Admin.deserializeUser());

app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => {
  res.locals.currentUser = req.user || null;
  next();
});

// State management for enrollments
let pendingEnrollment = null;
let lastEnrollmentStatus = null;
let pendingMigration = null;
let lastMigrationStatus = null;
let pendingTemplateDeletes = [];
let pendingSensorClear = null;
let lastSensorClearStatus = null;

// State getters and setters
const getPendingEnrollment = () => pendingEnrollment;
const getLastEnrollmentStatus = () => lastEnrollmentStatus;
const setPendingEnrollment = (value) => {
  pendingEnrollment = value;
};
const setLastEnrollmentStatus = (value) => {
  lastEnrollmentStatus = value;
};
const getPendingMigration = () => pendingMigration;
const getLastMigrationStatus = () => lastMigrationStatus;
const setPendingMigration = (value) => {
  pendingMigration = value;
};
const setLastMigrationStatus = (value) => {
  lastMigrationStatus = value;
};
const getPendingTemplateDeletes = () => pendingTemplateDeletes;
const setPendingTemplateDeletes = (value) => {
  pendingTemplateDeletes = value;
};
const getPendingSensorClear = () => pendingSensorClear;
const getLastSensorClearStatus = () => lastSensorClearStatus;
const setPendingSensorClear = (value) => {
  pendingSensorClear = value;
};
const setLastSensorClearStatus = (value) => {
  lastSensorClearStatus = value;
};

// Import and use route modules
app.use(
  createWebRoutes(
    ClassModel,
    Student,
    Attendance,
    Admin,
    getPendingEnrollment,
    getLastEnrollmentStatus,
    setPendingEnrollment,
    setLastEnrollmentStatus,
    getPendingTemplateDeletes,
    setPendingTemplateDeletes,
    getPendingSensorClear,
    getLastSensorClearStatus,
    setPendingSensorClear,
    setLastSensorClearStatus,
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
    getPendingTemplateDeletes,
    setPendingTemplateDeletes,
  ),
);
app.use(createAttendanceRoutes(Student, Attendance));
app.use(createAPIRoutes(ClassModel, Student));
app.use(
  createMigrationRoutes(
    Student,
    getPendingMigration,
    getLastMigrationStatus,
    setPendingMigration,
    setLastMigrationStatus,
  ),
);

async function bootstrap() {
  await connectDB();

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const existingAdmin = await Admin.findOne({ username: adminUsername }).select("_id").lean();
  if (!existingAdmin) {
    await Admin.register(new Admin({ username: adminUsername, displayName: "Administrator" }), adminPassword);
    console.log(`Default admin account created: ${adminUsername}`);
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Server bootstrap failed:", error);
  process.exit(1);
});
