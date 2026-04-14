/**
 * Attendance Routes - Mark attendance and view logs
 */
const express = require('express');
const router = express.Router();

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function getDailyLatestEvent(Attendance, studentId) {
  return Attendance.findOne({ student: studentId, createdAt: { $gte: todayStart() } }).sort({ createdAt: -1 });
}

async function getTodayEvents(Attendance, studentId) {
  return Attendance.find({ student: studentId, createdAt: { $gte: todayStart() } }).sort({ createdAt: 1 });
}

async function markAttendanceByFingerprintId(Student, Attendance, fingerprintId, source = 'ESP32') {
  const student = await Student.findOne({ fingerprintId });
  if (!student) {
    const error = new Error('unknown fingerprint id');
    error.statusCode = 404;
    throw error;
  }

  const events = await getTodayEvents(Attendance, student._id);
  const hasIn = events.some((event) => event.eventType === 'IN');
  const hasOut = events.some((event) => event.eventType === 'OUT');

  if (hasIn && hasOut) {
    const error = new Error('attendance already completed for today');
    error.statusCode = 409;
    throw error;
  }

  const eventType = hasIn ? 'OUT' : 'IN';
  const attendance = await Attendance.create({ student: student._id, eventType, source });

  return { student, attendance, eventType };
}

module.exports = (Student, Attendance) => {
  // GET /api/attendance/mark - Mark attendance (auto punch in/out)
  router.get('/api/attendance/mark', async (req, res) => {
    try {
      const fingerprintId = Number(req.query.id || req.query.fingerprintId);
      if (!fingerprintId) {
        return res.status(400).json({ ok: false, message: 'fingerprint id is required' });
      }

      const result = await markAttendanceByFingerprintId(Student, Attendance, fingerprintId, 'ESP32');
      return res.json({
        ok: true,
        message: `${result.student.name} marked ${result.eventType}`,
        student: {
          id: result.student._id,
          rollNumber: result.student.rollNumber,
          name: result.student.name,
          fingerprintId: result.student.fingerprintId,
        },
        attendance: {
          eventType: result.attendance.eventType,
          createdAt: result.attendance.createdAt,
          source: result.attendance.source,
        },
      });
    } catch (error) {
      console.error('GET /api/attendance/mark error:', error);
      return res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'server error' });
    }
  });

  // GET /api/attendance - Get all attendance logs
  router.get('/api/attendance', async (req, res) => {
    try {
      const logs = await Attendance.find().sort({ createdAt: -1 }).populate('student');
      res.json(
        logs.map((log) => ({
          rollNumber: log.student.rollNumber,
          name: log.student.name,
          fingerprintId: log.student.fingerprintId,
          eventType: log.eventType,
          source: log.source,
          createdAt: log.createdAt,
        }))
      );
    } catch (error) {
      console.error('GET /api/attendance error:', error);
      res.status(500).json({ ok: false, message: 'unable to fetch attendance logs' });
    }
  });

  // POST /api/attendance/punch-in - Manual punch in (web)
  router.post('/api/attendance/punch-in', async (req, res) => {
    try {
      const fingerprintId = Number(req.body.fingerprintId);
      if (!fingerprintId) {
        return res.status(400).json({ ok: false, message: 'fingerprint id is required' });
      }

      const student = await Student.findOne({ fingerprintId });
      if (!student) {
        return res.status(404).json({ ok: false, message: 'unknown fingerprint id' });
      }

      const events = await getTodayEvents(Attendance, student._id);
      const hasIn = events.some((event) => event.eventType === 'IN');
      if (hasIn) {
        return res.status(409).json({ ok: false, message: 'punch in already marked for today' });
      }

      const attendance = await Attendance.create({ student: student._id, eventType: 'IN', source: 'WEB' });
      return res.json({ ok: true, message: `${student.name} marked IN`, attendance });
    } catch (error) {
      console.error('POST /api/attendance/punch-in error:', error);
      return res.status(500).json({ ok: false, message: 'server error' });
    }
  });

  // POST /api/attendance/punch-out - Manual punch out (web)
  router.post('/api/attendance/punch-out', async (req, res) => {
    try {
      const fingerprintId = Number(req.body.fingerprintId);
      if (!fingerprintId) {
        return res.status(400).json({ ok: false, message: 'fingerprint id is required' });
      }

      const student = await Student.findOne({ fingerprintId });
      if (!student) {
        return res.status(404).json({ ok: false, message: 'unknown fingerprint id' });
      }

      const events = await getTodayEvents(Attendance, student._id);
      const hasIn = events.some((event) => event.eventType === 'IN');
      const hasOut = events.some((event) => event.eventType === 'OUT');
      if (!hasIn) {
        return res.status(409).json({ ok: false, message: 'cannot punch out before punch in' });
      }
      if (hasOut) {
        return res.status(409).json({ ok: false, message: 'punch out already marked for today' });
      }

      const attendance = await Attendance.create({ student: student._id, eventType: 'OUT', source: 'WEB' });
      return res.json({ ok: true, message: `${student.name} marked OUT`, attendance });
    } catch (error) {
      console.error('POST /api/attendance/punch-out error:', error);
      return res.status(500).json({ ok: false, message: 'server error' });
    }
  });

  return router;
};
