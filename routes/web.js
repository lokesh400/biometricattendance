/**
 * Web Routes - Main page and student registration
 */
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const router = express.Router();

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = (ClassModel, Student, Attendance, getPendingEnrollment, getLastEnrollmentStatus, setPendingEnrollment, setLastEnrollmentStatus) => {
  // GET / - Dashboard
  router.get('/', async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();
      const requestedClassId = String(req.query.classId || '').trim();
      const activeClassId =
        requestedClassId && mongoose.Types.ObjectId.isValid(requestedClassId)
          ? requestedClassId
          : (classes[0]?._id ? String(classes[0]._id) : '');

      let students = [];
      let logs = [];
      let studentCount = 0;
      let inCount = 0;
      let outCount = 0;
      let activeSessionsCount = 0;

      if (activeClassId) {
        const classObjectId = new mongoose.Types.ObjectId(activeClassId);

        students = await Student.find({ classId: classObjectId })
          .sort({ createdAt: -1 })
          .lean();

        const studentIds = students.map((s) => s._id);

        if (studentIds.length > 0) {
          logs = await Attendance.find({ student: { $in: studentIds } })
            .sort({ createdAt: -1 })
            .populate('student')
            .limit(50)
            .lean();

          inCount = await Attendance.countDocuments({
            student: { $in: studentIds },
            eventType: 'IN',
            createdAt: { $gte: todayStart() },
          });

          outCount = await Attendance.countDocuments({
            student: { $in: studentIds },
            eventType: 'OUT',
            createdAt: { $gte: todayStart() },
          });

          const activeCount = await Attendance.aggregate([
            {
              $match: {
                student: { $in: studentIds },
                createdAt: { $gte: todayStart() },
              },
            },
            { $sort: { createdAt: -1 } },
            {
              $group: {
                _id: '$student',
                eventType: { $first: '$eventType' },
              },
            },
            { $match: { eventType: 'IN' } },
            { $count: 'total' },
          ]);

          activeSessionsCount = activeCount[0]?.total || 0;
        }

        studentCount = students.length;
      }

      const stats = {
        students: studentCount,
        punchIn: inCount,
        punchOut: outCount,
        activeSessions: activeSessionsCount,
      };

      res.render('index', {
        classes,
        activeClassId,
        students,
        logs,
        stats,
        pendingEnrollment: getPendingEnrollment(),
        lastEnrollmentStatus: getLastEnrollmentStatus(),
        notice: req.query.notice || '',
        error: req.query.error || '',
      });
    } catch (error) {
      console.error('GET / error:', error);
      res.status(500).render('index', {
        classes: [],
        activeClassId: '',
        students: [],
        logs: [],
        stats: { students: 0, punchIn: 0, punchOut: 0, activeSessions: 0 },
        pendingEnrollment: null,
        lastEnrollmentStatus: null,
        notice: '',
        error: 'Failed to load dashboard',
      });
    }
  });

  // POST /students - Register new student (triggers enrollment)
  router.post('/students', async (req, res) => {
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
        return res.redirect('/?error=' + encodeURIComponent(message) + (classId ? `&classId=${encodeURIComponent(classId)}` : ''));
      }

      if (!mongoose.Types.ObjectId.isValid(classId)) {
        const message = 'Invalid class selected.';
        if (wantsJson) {
          return res.status(400).json({ ok: false, message });
        }
        return res.redirect('/?error=' + encodeURIComponent(message));
      }

      const selectedClass = await ClassModel.findById(classId).lean();
      if (!selectedClass) {
        const message = 'Selected class was not found.';
        if (wantsJson) {
          return res.status(404).json({ ok: false, message });
        }
        return res.redirect('/?error=' + encodeURIComponent(message));
      }

      if (getPendingEnrollment()) {
        const message = 'An enrollment is already in progress. Complete it before adding another student.';
        if (wantsJson) {
          return res.status(409).json({ ok: false, message, pendingEnrollment: getPendingEnrollment() });
        }
        return res.redirect('/?error=' + encodeURIComponent(message));
      }

      const existing = await Student.findOne({ rollNumber }).select('_id');
      if (existing) {
        const message = 'Roll number already exists.';
        if (wantsJson) {
          return res.status(409).json({ ok: false, message });
        }
        return res.redirect('/?error=' + encodeURIComponent(message));
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

      return res.redirect(
        '/?notice=' + encodeURIComponent(`Enrollment started for ${name} in ${selectedClass.name}. Ask student to place finger on the sensor (ID ${fingerprintId}).`) +
          `&classId=${encodeURIComponent(classId)}`
      );
    } catch (error) {
      console.error('POST /students error:', error);
      const message = error.code === 11000 ? 'Roll number or fingerprint ID already exists.' : 'Unable to register student.';
      if (req.accepts(['json', 'html']) === 'json') {
        return res.status(500).json({ ok: false, message });
      }
      return res.redirect('/?error=' + encodeURIComponent(message));
    }
  });

  return router;
};
