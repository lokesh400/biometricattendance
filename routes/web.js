/**
 * Web Routes - Main page and student registration
 */
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const passport = require('passport');
const router = express.Router();

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function toStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toEndOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function parseDateOnly(value) {
  const str = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return null;
  }
  const d = new Date(`${str}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateInputValue(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = (
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
) => {
  function isAdminAuthenticated(req) {
    return typeof req.isAuthenticated === 'function' && req.isAuthenticated();
  }

  function denyAdminAccess(req, res) {
    const message = 'Admin login required';
    if (req.method === 'GET' && !String(req.originalUrl || '').startsWith('/api/')) {
      if (req.session) {
        req.session.returnTo = req.originalUrl;
      }
      return res.redirect('/login');
    }
    return res.status(401).json({ ok: false, message });
  }

  function requireAdmin(req, res, next) {
    if (isAdminAuthenticated(req)) {
      return next();
    }
    return denyAdminAccess(req, res);
  }

  router.get('/login', (req, res) => {
    if (isAdminAuthenticated(req)) {
      return res.redirect('/admin');
    }

    return res.render('login', {
      error: req.query.error ? 'Invalid username or password.' : '',
      nextUrl: String(req.query.next || (req.session && req.session.returnTo) || '/admin'),
    });
  });

  router.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user) => {
      if (err) {
        return next(err);
      }

      if (!user) {
        return res.status(401).render('login', {
          error: 'Invalid username or password.',
          nextUrl: String(req.body.next || (req.session && req.session.returnTo) || '/admin'),
        });
      }

      req.logIn(user, (loginErr) => {
        if (loginErr) {
          return next(loginErr);
        }

        const redirectTo = String(req.body.next || (req.session && req.session.returnTo) || '/admin');
        if (req.session) {
          req.session.returnTo = null;
        }
        return res.redirect(redirectTo.startsWith('/') ? redirectTo : '/admin');
      });
    })(req, res, next);
  });

  router.get('/logout', (req, res, next) => {
    if (typeof req.logout !== 'function') {
      return res.redirect('/login');
    }

    req.logout((err) => {
      if (err) {
        return next(err);
      }
      return res.redirect('/login');
    });
  });

  // Require admin auth for all web pages and web actions after login/logout routes.
  router.use((req, res, next) => requireAdmin(req, res, next));

  // GET / - Home/landing page with system overview
  router.get('/', async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();
      const totalClasses = classes.length;

      let totalStudents = 0;
      let todayAttendance = 0;

      if (classes.length > 0) {
        totalStudents = classes.reduce((sum, cls) => sum + (cls.studentCount || 0), 0);

        // Get today's attendance count
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const todayAttendanceCount = await Attendance.countDocuments({
          createdAt: { $gte: todayStart, $lte: todayEnd },
        });
        todayAttendance = todayAttendanceCount;
      }

      res.render('index', {
        classes,
        activeClassId: classes[0]?._id ? String(classes[0]._id) : '',
        pageType: 'home',
        stats: {
          totalClasses,
          totalStudents,
          todayAttendance,
        },
      });
    } catch (error) {
      console.error('GET / error:', error);
      res.render('index', {
        classes: [],
        activeClassId: '',
        pageType: 'home',
        stats: {
          totalClasses: 0,
          totalStudents: 0,
          todayAttendance: 0,
        },
      });
    }
  });
  // GET /class/:classId - Class dashboard (students management)
  router.get('/class/:classId', async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();
      const requestedClassId = String(req.params.classId || req.query.classId || '').trim();
      const activeClassId =
        requestedClassId && mongoose.Types.ObjectId.isValid(requestedClassId)
          ? requestedClassId
          : (classes[0]?._id ? String(classes[0]._id) : '');
      const activeClass = classes.find((c) => String(c._id) === String(activeClassId)) || null;

      let students = [];
      let studentCount = 0;

      if (activeClassId) {
        const classObjectId = new mongoose.Types.ObjectId(activeClassId);

        students = await Student.find({ classId: classObjectId })
          .sort({ createdAt: -1 })
          .lean();

        studentCount = students.length;
      }

      res.render('layout', {
        page: 'class',
        classes,
        activeClassId,
        activeClassName: activeClass ? activeClass.name : '',
        students,
        pendingEnrollment: getPendingEnrollment(),
        lastEnrollmentStatus: getLastEnrollmentStatus(),
      });
    } catch (error) {
      console.error('GET /class/:classId error:', error);
      res.status(500).render('layout', {
        page: 'class',
        classes: [],
        activeClassId: '',
        activeClassName: '',
        students: [],
        pendingEnrollment: null,
        lastEnrollmentStatus: null,
      });
    }
  });

  // GET /class/:classId/attendance - Class attendance dashboard
  router.get('/class/:classId/attendance', async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();
      const requestedClassId = String(req.params.classId || '').trim();

      if (!mongoose.Types.ObjectId.isValid(requestedClassId)) {
        return res.redirect('/');
      }

      const activeClass = classes.find((c) => String(c._id) === requestedClassId) || null;
      if (!activeClass) {
        return res.redirect('/');
      }

      const classObjectId = new mongoose.Types.ObjectId(requestedClassId);
      const students = await Student.find({ classId: classObjectId }).sort({ createdAt: -1 }).lean();
      const studentIds = students.map((s) => s._id);

      const queryDate = String(req.query.date || '').trim();
      const queryFromDate = String(req.query.fromDate || '').trim();
      const queryToDate = String(req.query.toDate || '').trim();
      const hasRangeQuery = Boolean(queryFromDate || queryToDate);

      const today = new Date();
      const selectedSingleDate = parseDateOnly(queryDate) || today;
      let rangeFrom = parseDateOnly(queryFromDate);
      let rangeTo = parseDateOnly(queryToDate);

      if (hasRangeQuery) {
        if (!rangeFrom && rangeTo) {
          rangeFrom = new Date(rangeTo);
        }
        if (!rangeTo && rangeFrom) {
          rangeTo = new Date(rangeFrom);
        }
        if (!rangeFrom && !rangeTo) {
          rangeFrom = new Date(today);
          rangeTo = new Date(today);
        }
      }

      if (hasRangeQuery && rangeFrom && rangeTo && rangeFrom > rangeTo) {
        const tmp = rangeFrom;
        rangeFrom = rangeTo;
        rangeTo = tmp;
      }

      const isRangeMode = hasRangeQuery;
      const filterStart = isRangeMode ? toStartOfDay(rangeFrom) : toStartOfDay(selectedSingleDate);
      const filterEnd = isRangeMode ? toEndOfDay(rangeTo) : toEndOfDay(selectedSingleDate);

      let logs = [];
      let attendanceRows = [];
      let inCount = 0;
      let outCount = 0;
      let activeSessionsCount = 0;
      let rangeDates = [];
      let rangeRows = [];

      if (studentIds.length > 0) {
        const filteredLogs = await Attendance.find({
          student: { $in: studentIds },
          createdAt: { $gte: filterStart, $lte: filterEnd },
        })
          .sort({ createdAt: 1 })
          .lean();

        if (isRangeMode) {
          const cursor = new Date(filterStart);
          while (cursor <= filterEnd) {
            const key = toDateInputValue(cursor);
            rangeDates.push({
              key,
              label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
              dayName: cursor.toLocaleDateString('en-US', { weekday: 'short' }),
            });
            cursor.setDate(cursor.getDate() + 1);
          }

          const dateKeys = rangeDates.map((d) => d.key);
          const rangeMap = new Map(
            students.map((student) => [
              String(student._id),
              {
                student,
                days: Object.fromEntries(dateKeys.map((k) => [k, { inAt: null, outAt: null, present: false }])),
                totalPresents: 0,
              },
            ]),
          );

          for (const log of filteredLogs) {
            const key = String(log.student);
            const row = rangeMap.get(key);
            if (!row) {
              continue;
            }

            const dayKey = toDateInputValue(log.createdAt);
            const day = row.days[dayKey];
            if (!day) {
              continue;
            }

            day.present = true;
            if (log.eventType === 'IN' && !day.inAt) {
              day.inAt = log.createdAt;
              continue;
            }
            if (log.eventType === 'OUT' && !day.outAt) {
              day.outAt = log.createdAt;
            }
          }

          rangeRows = Array.from(rangeMap.values())
            .map((row) => {
              const totalPresents = rangeDates.reduce((sum, d) => {
                const day = row.days[d.key];
                return sum + (day && day.present ? 1 : 0);
              }, 0);
              return { ...row, totalPresents };
            })
            .sort((a, b) => {
              const byRoll = String(a.student.rollNumber || '').localeCompare(String(b.student.rollNumber || ''));
              if (byRoll !== 0) {
                return byRoll;
              }
              return String(a.student.name || '').localeCompare(String(b.student.name || ''));
            });

          inCount = filteredLogs.filter((log) => log.eventType === 'IN').length;
          outCount = filteredLogs.filter((log) => log.eventType === 'OUT').length;
        } else {
          logs = await Attendance.find({
            student: { $in: studentIds },
            createdAt: { $gte: filterStart, $lte: filterEnd },
          })
            .sort({ createdAt: -1 })
            .populate('student')
            .limit(100)
            .lean();

          const rowsByStudent = new Map(
            students.map((student) => [
              String(student._id),
              {
                student,
                punchInAt: null,
                punchOutAt: null,
                onsiteMinutes: null,
                status: 'ABSENT',
                inEvents: 0,
                outEvents: 0,
              },
            ]),
          );

          for (const log of filteredLogs) {
            const key = String(log.student);
            const row = rowsByStudent.get(key);
            if (!row) {
              continue;
            }

            if (log.eventType === 'IN') {
              row.inEvents += 1;
              if (!row.punchInAt) {
                row.punchInAt = log.createdAt;
                row.status = 'INSIDE';
              }
              continue;
            }

            if (log.eventType === 'OUT') {
              row.outEvents += 1;
              if (row.punchInAt && !row.punchOutAt) {
                const inAt = new Date(row.punchInAt);
                const outAt = new Date(log.createdAt);
                if (outAt >= inAt) {
                  row.punchOutAt = log.createdAt;
                  row.onsiteMinutes = Math.max(0, Math.round((outAt - inAt) / 60000));
                  row.status = 'COMPLETED';
                }
              }
            }
          }

          for (const row of rowsByStudent.values()) {
            if (row.punchInAt && !row.punchOutAt) {
              const inAt = new Date(row.punchInAt);
              row.onsiteMinutes = Math.max(0, Math.round((Date.now() - inAt.getTime()) / 60000));
            }
          }

          attendanceRows = Array.from(rowsByStudent.values()).sort((a, b) => {
            const byRoll = String(a.student.rollNumber || '').localeCompare(String(b.student.rollNumber || ''));
            if (byRoll !== 0) {
              return byRoll;
            }
            return String(a.student.name || '').localeCompare(String(b.student.name || ''));
          });

          inCount = attendanceRows.filter((row) => Boolean(row.punchInAt)).length;
          outCount = attendanceRows.filter((row) => Boolean(row.punchOutAt)).length;
          activeSessionsCount = attendanceRows.filter((row) => row.punchInAt && !row.punchOutAt).length;
        }
      }

      const periodLabel = isRangeMode
        ? `${filterStart.toLocaleDateString()} - ${filterEnd.toLocaleDateString()}`
        : filterStart.toLocaleDateString();

      res.render('layout', {
        page: isRangeMode ? 'attendance-range' : 'attendance',
        classes,
        activeClassId: requestedClassId,
        activeClassName: activeClass.name,
        attendanceRows,
        logs,
        rangeDates,
        rangeRows,
        attendanceFilter: {
          mode: isRangeMode ? 'range' : 'single',
          date: toDateInputValue(selectedSingleDate),
          fromDate: isRangeMode ? toDateInputValue(filterStart) : '',
          toDate: isRangeMode ? toDateInputValue(filterEnd) : '',
          periodLabel,
        },
        stats: {
          students: students.length,
          punchIn: inCount,
          punchOut: outCount,
          activeSessions: activeSessionsCount,
        },
      });
    } catch (error) {
      console.error('GET /class/:classId/attendance error:', error);
      return res.redirect('/');
    }
  });

  // POST /students - Register new student (triggers enrollment)
  router.post('/students', requireAdmin, async (req, res) => {
    try {
      const wantsJson = req.accepts(['json', 'html']) === 'json';
      const rollNumber = String(req.body.rollNumber || '').trim();
      const name = String(req.body.name || '').trim();
      const classId = String(req.body.classId || '').trim();

      if (!rollNumber || !name || !classId) {
        const message = 'Class, roll number and name are required.';
        if (wantsJson) {
          return res.status(400).json({ ok: false, message });
        }
        return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
      }

      if (!mongoose.Types.ObjectId.isValid(classId)) {
        const message = 'Invalid class selected.';
        if (wantsJson) {
          return res.status(400).json({ ok: false, message });
        }
        return res.redirect('/');
      }

      const selectedClass = await ClassModel.findById(classId).lean();
      if (!selectedClass) {
        const message = 'Selected class was not found.';
        if (wantsJson) {
          return res.status(404).json({ ok: false, message });
        }
        return res.redirect('/');
      }

      if (getPendingEnrollment()) {
        const message = 'An enrollment is already in progress. Complete it before adding another student.';
        if (wantsJson) {
          return res.status(409).json({ ok: false, message, pendingEnrollment: getPendingEnrollment() });
        }
        return res.redirect(`/class/${encodeURIComponent(classId)}`);
      }

      const existing = await Student.findOne({ rollNumber }).select('_id');
      if (existing) {
        const message = 'Roll number already exists.';
        if (wantsJson) {
          return res.status(409).json({ ok: false, message });
        }
        return res.redirect(`/class/${encodeURIComponent(classId)}`);
      }

      const latest = await Student.findOne().sort({ fingerprintId: -1 }).select('fingerprintId');
      const fingerprintId = latest ? latest.fingerprintId + 1 : 1;

      const pendingData = {
        requestId: crypto.randomBytes(8).toString('hex'),
        rollNumber,
        name,
        classId,
        className: selectedClass.name,
        fingerprintId,
        createdAt: new Date(),
      };

      setPendingEnrollment(pendingData);
      setLastEnrollmentStatus({
        state: 'pending',
        message: `Enrollment started for ${name} in ${selectedClass.name} (ID ${fingerprintId}). Waiting for ESP32...`,
        requestId: pendingData.requestId,
        at: new Date(),
      });

      if (wantsJson) {
        return res.json({
          ok: true,
          message: `Enrollment started for ${name} in ${selectedClass.name}. Ask student to place finger on the sensor (ID ${fingerprintId}).`,
          pendingEnrollment: pendingData,
        });
      }

      return res.redirect(`/class/${encodeURIComponent(classId)}`);
    } catch (error) {
      console.error('POST /students error:', error);
      const message = error.code === 11000 ? 'Roll number or fingerprint ID already exists.' : 'Unable to register student.';
      if (req.accepts(['json', 'html']) === 'json') {
        return res.status(500).json({ ok: false, message });
      }
      return res.redirect('/');
    }
  });

  // POST /students/:studentId/delete - Delete student and all related records
  router.post('/students/:studentId/delete', requireAdmin, async (req, res) => {
    try {
      const wantsJson = req.accepts(['json', 'html']) === 'json';
      const studentId = String(req.params.studentId || '').trim();
      const classId = String(req.body.classId || '').trim();

      if (!mongoose.Types.ObjectId.isValid(studentId)) {
        const message = 'Invalid student id.';
        if (wantsJson) {
          return res.status(400).json({ ok: false, message });
        }
        return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
      }

      const student = await Student.findById(studentId).select('_id classId name rollNumber fingerprintId').lean();
      if (!student) {
        const message = 'Student not found.';
        if (wantsJson) {
          return res.status(404).json({ ok: false, message });
        }
        return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
      }

      await Attendance.deleteMany({ student: student._id });
      await Student.deleteOne({ _id: student._id });

      // Queue sensor-side template deletion so scanner memory stays in sync with MongoDB.
      if (Number(student.fingerprintId) > 0) {
        const pendingDeletes = getPendingTemplateDeletes();
        const requestId = crypto.randomBytes(8).toString('hex');
        pendingDeletes.push({
          requestId,
          fingerprintId: Number(student.fingerprintId),
          studentName: student.name,
          rollNumber: student.rollNumber,
          createdAt: new Date(),
        });
        setPendingTemplateDeletes(pendingDeletes);
      }

      const studentClassId = String(student.classId || classId || '').trim();
      if (studentClassId && mongoose.Types.ObjectId.isValid(studentClassId)) {
        const remainingCount = await Student.countDocuments({ classId: new mongoose.Types.ObjectId(studentClassId) });
        await ClassModel.findByIdAndUpdate(studentClassId, { $set: { studentCount: remainingCount } }).exec();
      }

      if (wantsJson) {
        return res.json({
          ok: true,
          message: `Deleted student ${student.name}, related attendance, and queued scanner template delete.`,
        });
      }

      return res.redirect(studentClassId ? `/class/${encodeURIComponent(studentClassId)}` : '/');
    } catch (error) {
      console.error('POST /students/:studentId/delete error:', error);
      const message = 'Unable to delete student.';
      if (req.accepts(['json', 'html']) === 'json') {
        return res.status(500).json({ ok: false, message });
      }
      const classId = String(req.body.classId || '').trim();
      return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
    }
  });

  // POST /students/:studentId/fingerprint/register - Enroll/re-enroll fingerprint for existing student
  router.post('/students/:studentId/fingerprint/register', requireAdmin, async (req, res) => {
    try {
      const wantsJson = req.accepts(['json', 'html']) === 'json';
      const studentId = String(req.params.studentId || '').trim();
      const classId = String(req.body.classId || '').trim();

      if (!mongoose.Types.ObjectId.isValid(studentId)) {
        const message = 'Invalid student id.';
        if (wantsJson) {
          return res.status(400).json({ ok: false, message });
        }
        return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
      }

      if (getPendingEnrollment()) {
        const message = 'An enrollment is already in progress. Complete it before starting another.';
        if (wantsJson) {
          return res.status(409).json({ ok: false, message, pendingEnrollment: getPendingEnrollment() });
        }
        return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
      }

      const student = await Student.findById(studentId)
        .select('_id classId rollNumber name fingerprintId')
        .lean();

      if (!student) {
        const message = 'Student not found.';
        if (wantsJson) {
          return res.status(404).json({ ok: false, message });
        }
        return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
      }

      let fingerprintId = Number(student.fingerprintId || 0);
      if (fingerprintId <= 0) {
        const latest = await Student.findOne().sort({ fingerprintId: -1 }).select('fingerprintId').lean();
        fingerprintId = (latest?.fingerprintId || 0) + 1;
      }

      const requestId = crypto.randomBytes(8).toString('hex');
      const pendingData = {
        requestId,
        mode: 'update',
        studentId: String(student._id),
        rollNumber: student.rollNumber,
        name: student.name,
        classId: String(student.classId || classId || ''),
        fingerprintId,
        createdAt: new Date(),
      };

      setPendingEnrollment(pendingData);
      setLastEnrollmentStatus({
        state: 'pending',
        requestId,
        message: `Fingerprint enrollment started for ${student.name} (ID ${fingerprintId}).`,
        at: new Date(),
      });

      if (wantsJson) {
        return res.json({
          ok: true,
          message: `Fingerprint enrollment started for ${student.name}. Ask student to place finger on scanner.`,
          pendingEnrollment: pendingData,
        });
      }

      return res.redirect(student.classId ? `/class/${encodeURIComponent(String(student.classId))}` : '/');
    } catch (error) {
      console.error('POST /students/:studentId/fingerprint/register error:', error);
      const message = 'Unable to start fingerprint enrollment for student.';
      if (req.accepts(['json', 'html']) === 'json') {
        return res.status(500).json({ ok: false, message });
      }
      const classId = String(req.body.classId || '').trim();
      return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
    }
  });

  // POST /class/:classId/delete-all - Delete entire class and all related data
  router.post('/class/:classId/delete-all', requireAdmin, async (req, res) => {
    try {
      const wantsJson = req.accepts(['json', 'html']) === 'json';
      const classId = String(req.params.classId || req.body.classId || '').trim();

      if (!mongoose.Types.ObjectId.isValid(classId)) {
        const message = 'Invalid class id.';
        if (wantsJson) {
          return res.status(400).json({ ok: false, message });
        }
        return res.redirect('/');
      }

      const classObjectId = new mongoose.Types.ObjectId(classId);
      const targetClass = await ClassModel.findById(classObjectId).select('_id name code').lean();
      if (!targetClass) {
        const message = 'Class not found.';
        if (wantsJson) {
          return res.status(404).json({ ok: false, message });
        }
        return res.redirect('/');
      }

      const students = await Student.find({ classId: classObjectId })
        .select('_id name rollNumber fingerprintId')
        .lean();

      const pendingDeletes = getPendingTemplateDeletes();
      let queuedSensorDeletes = 0;
      for (const student of students) {
        const fingerprintId = Number(student.fingerprintId || 0);
        if (fingerprintId <= 0) {
          continue;
        }
        pendingDeletes.push({
          requestId: crypto.randomBytes(8).toString('hex'),
          fingerprintId,
          studentName: student.name,
          rollNumber: student.rollNumber,
          createdAt: new Date(),
        });
        queuedSensorDeletes += 1;
      }
      setPendingTemplateDeletes(pendingDeletes);

      const studentIds = students.map((student) => student._id);
      await Attendance.deleteMany({ student: { $in: studentIds } });
      await Student.deleteMany({ classId: classObjectId });
      await ClassModel.deleteOne({ _id: classObjectId });

      const message = `Deleted class ${targetClass.name} and ${students.length} students. Queued ${queuedSensorDeletes} sensor template deletions.`;
      if (wantsJson) {
        return res.json({ ok: true, message, deletedStudents: students.length, queuedSensorDeletes, deletedClass: targetClass.name });
      }
      return res.redirect('/');
    } catch (error) {
      console.error('POST /class/:classId/delete-all error:', error);
      const message = 'Unable to delete full class data.';
      if (req.accepts(['json', 'html']) === 'json') {
        return res.status(500).json({ ok: false, message });
      }
      const classId = String(req.params.classId || req.body.classId || '').trim();
      return res.redirect(classId ? `/class/${encodeURIComponent(classId)}` : '/');
    }
  });

  // GET /enrollment - Student enrollment workflow page
  router.get('/enrollment', async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();

      res.render('layout', {
        page: 'enrollment',
        classes,
        activeClassId: '',
        activeClassName: 'Enrollment workflow',
        enrollmentLogs: [],
      });
    } catch (error) {
      console.error('GET /enrollment error:', error);
      res.status(500).render('layout', {
        page: 'enrollment',
        classes: [],
        activeClassId: '',
        activeClassName: 'Enrollment workflow',
        enrollmentLogs: [],
      });
    }
  });

  // GET /admin - System administration and sensor management
  router.get('/admin', requireAdmin, async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();
      const classCount = await ClassModel.countDocuments();
      const studentCount = await Student.countDocuments();

      res.render('layout', {
        page: 'admin',
        classes,
        classCount,
        studentCount,
        espStatus: 'Connected',
        lastHeartbeat: null,
        activeClassId: '',
        activeClassName: 'System Admin',
      });
    } catch (error) {
      console.error('GET /admin error:', error);
      res.status(500).render('layout', {
        page: 'admin',
        classes: [],
        classCount: 0,
        studentCount: 0,
        espStatus: 'Disconnected',
        lastHeartbeat: null,
        activeClassId: '',
        activeClassName: 'System Admin',
      });
    }
  });

  return router;
};
