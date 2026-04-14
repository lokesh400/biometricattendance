/**
 * Device Enrollment Routes - ESP32 fingerprint enrollment
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

module.exports = (
  ClassModel,
  Student,
  Attendance,
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
) => {
  function isAdminAuthenticated(req) {
    return typeof req.isAuthenticated === 'function' && req.isAuthenticated();
  }

  function denyAdminAccess(req, res) {
    const message = 'Admin login required';
    if (req.method === 'GET' && !String(req.originalUrl || '').startsWith('/api/')) {
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
  // GET /api/device/enrollment/next - Get next enrollment task for ESP32
  router.get('/api/device/enrollment/next', (req, res) => {
    const pending = getPendingEnrollment();
    if (!pending) {
      return res.type('text/plain').send('NONE');
    }

    return res
      .type('text/plain')
      .send(`ENROLL|${pending.requestId}|${pending.fingerprintId}|${pending.rollNumber}|${pending.name}`);
  });

  // POST /api/device/enrollment/result - Receive enrollment result from ESP32
  router.post('/api/device/enrollment/result', async (req, res) => {
    try {
      const requestId = String(req.body.requestId || '').trim();
      const successRaw = String(req.body.success || '').trim().toLowerCase();
      const message = String(req.body.message || '').trim();
      const templateHex = String(req.body.templateHex || '').trim();

      const pending = getPendingEnrollment();
      if (!pending || requestId !== pending.requestId) {
        return res.status(400).json({ ok: false, message: 'no matching pending enrollment' });
      }

      const isSuccess = successRaw === '1' || successRaw === 'true' || successRaw === 'yes';
      const isUpdateMode = String(pending.mode || '').toLowerCase() === 'update';

      if (!isSuccess) {
        const failedName = pending.name;
        setLastEnrollmentStatus({
          state: 'failed',
          requestId,
          message: `Enrollment failed for ${failedName}. ${message || 'Please retry.'}`,
          at: new Date(),
        });
        setPendingEnrollment(null);
        return res.status(200).json({ ok: false, saved: false, message: `Enrollment failed for ${failedName}. ${message || 'Please retry.'}` });
      }

      let student;
      if (isUpdateMode) {
        student = await Student.findByIdAndUpdate(
          pending.studentId,
          {
            $set: {
              fingerprintId: pending.fingerprintId,
              fingerprintTemplateHex: templateHex,
              fingerprintTemplateFormat: templateHex ? 'adafruit-template-hex-v1' : '',
            },
          },
          { new: true },
        );

        if (!student) {
          setPendingEnrollment(null);
          setLastEnrollmentStatus({
            state: 'failed',
            requestId,
            message: 'Student not found while finalizing fingerprint update.',
            at: new Date(),
          });
          return res.status(404).json({ ok: false, message: 'student not found while finalizing update' });
        }
      } else {
        student = await Student.create({
          rollNumber: pending.rollNumber,
          name: pending.name,
          fingerprintId: pending.fingerprintId,
          classId: pending.classId,
          fingerprintTemplateHex: templateHex,
          fingerprintTemplateFormat: templateHex ? 'adafruit-template-hex-v1' : '',
        });

        if (pending.classId) {
          await ClassModel.findByIdAndUpdate(pending.classId, { $inc: { studentCount: 1 } }).exec();
        }
      }

      const templateStored = Boolean(templateHex);
      const backupMessage = templateStored ? 'Template backup saved in MongoDB.' : 'Template backup not captured.';

      setPendingEnrollment(null);
      setLastEnrollmentStatus({
        state: 'saved',
        requestId,
        message: isUpdateMode
          ? `Fingerprint updated for ${student.name} with ID ${student.fingerprintId}. ${backupMessage}`
          : `Enrollment complete. Student ${student.name} saved with fingerprint ID ${student.fingerprintId}. ${backupMessage}`,
        student: {
          rollNumber: student.rollNumber,
          name: student.name,
          fingerprintId: student.fingerprintId,
          classId: student.classId,
          fingerprintTemplateStored: templateStored,
        },
        at: new Date(),
      });
      return res.json({
        ok: true,
        saved: true,
        templateStored,
        message: isUpdateMode
          ? `Fingerprint updated for ${student.name} with ID ${student.fingerprintId}. ${backupMessage}`
          : `Enrollment complete. Student ${student.name} saved with fingerprint ID ${student.fingerprintId}. ${backupMessage}`,
      });
    } catch (error) {
      console.error('POST /api/device/enrollment/result error:', error);
      setLastEnrollmentStatus({
        state: 'error',
        message: 'Unable to finalize enrollment due to server error.',
        at: new Date(),
      });
      setPendingEnrollment(null);
      return res.status(500).json({ ok: false, message: 'unable to finalize enrollment' });
    }
  });

  // GET /api/device/enrollment/status - Get current enrollment status (for live polling)
  router.get('/api/device/enrollment/status', (req, res) => {
    res.json({ pendingEnrollment: getPendingEnrollment(), lastEnrollmentStatus: getLastEnrollmentStatus() });
  });

  // GET /api/device/delete/next - Get next fingerprint template deletion task for ESP32
  router.get('/api/device/delete/next', (req, res) => {
    const queue = getPendingTemplateDeletes();
    if (!queue.length) {
      return res.type('text/plain').send('NONE');
    }

    const next = queue[0];
    return res.type('text/plain').send(`DELETE|${next.requestId}|${next.fingerprintId}|${next.studentName}|${next.rollNumber}`);
  });

  // POST /api/device/delete/result - Receive template deletion result from ESP32
  router.post('/api/device/delete/result', (req, res) => {
    try {
      const requestId = String(req.body.requestId || '').trim();
      const successRaw = String(req.body.success || '').trim().toLowerCase();
      const message = String(req.body.message || '').trim();

      const queue = getPendingTemplateDeletes();
      if (!queue.length) {
        return res.status(400).json({ ok: false, message: 'no delete task pending' });
      }

      const current = queue[0];
      if (requestId !== current.requestId) {
        return res.status(400).json({ ok: false, message: 'delete request mismatch' });
      }

      const isSuccess = successRaw === '1' || successRaw === 'true' || successRaw === 'yes';
      if (!isSuccess) {
        console.warn('Scanner delete failed:', current.fingerprintId, message);
      }

      queue.shift();
      setPendingTemplateDeletes(queue);

      return res.json({ ok: true });
    } catch (error) {
      console.error('POST /api/device/delete/result error:', error);
      return res.status(500).json({ ok: false, message: 'unable to process delete result' });
    }
  });

  // POST /api/device/sensor/clear/request - Triple-confirmed full sensor clear request
  router.post('/api/device/sensor/clear/request', requireAdmin, (req, res) => {
    try {
      const confirm1 = String(req.body.confirm1 || '').trim().toUpperCase();
      const confirm2 = String(req.body.confirm2 || '').trim().toUpperCase();
      const confirm3 = String(req.body.confirm3 || '').trim().toUpperCase();

      if (confirm1 !== 'CLEAR' || confirm2 !== 'CLEAR' || confirm3 !== 'CLEAR') {
        return res.status(400).json({ ok: false, message: 'triple confirmation failed; type CLEAR all three times' });
      }

      if (getPendingSensorClear()) {
        return res.status(409).json({ ok: false, message: 'sensor clear already pending' });
      }

      const request = {
        requestId: crypto.randomBytes(8).toString('hex'),
        createdAt: new Date(),
      };

      setPendingSensorClear(request);
      setLastSensorClearStatus({
        state: 'pending',
        requestId: request.requestId,
        message: 'Sensor clear requested. Waiting for ESP32 to confirm.',
        at: new Date(),
      });

      return res.json({ ok: true, message: 'Sensor clear request queued.', requestId: request.requestId });
    } catch (error) {
      console.error('POST /api/device/sensor/clear/request error:', error);
      return res.status(500).json({ ok: false, message: 'unable to queue sensor clear request' });
    }
  });

  // GET /api/device/sensor/clear/next - Get sensor clear task for ESP32
  router.get('/api/device/sensor/clear/next', (req, res) => {
    const pending = getPendingSensorClear();
    if (!pending) {
      return res.type('text/plain').send('NONE');
    }

    return res.type('text/plain').send(`CLEAR_SENSOR|${pending.requestId}`);
  });

  // POST /api/device/sensor/clear/result - Receive sensor clear result from ESP32
  router.post('/api/device/sensor/clear/result', (req, res) => {
    try {
      const pending = getPendingSensorClear();
      if (!pending) {
        return res.status(400).json({ ok: false, message: 'no sensor clear task pending' });
      }

      const requestId = String(req.body.requestId || '').trim();
      const successRaw = String(req.body.success || '').trim().toLowerCase();
      const message = String(req.body.message || '').trim();

      if (requestId !== pending.requestId) {
        return res.status(400).json({ ok: false, message: 'sensor clear request mismatch' });
      }

      const success = successRaw === '1' || successRaw === 'true' || successRaw === 'yes';
      setLastSensorClearStatus({
        state: success ? 'completed' : 'failed',
        requestId,
        message: success ? 'Sensor memory cleared successfully.' : `Sensor clear failed. ${message || ''}`.trim(),
        at: new Date(),
      });
      setPendingSensorClear(null);

      return res.json({ ok: success });
    } catch (error) {
      console.error('POST /api/device/sensor/clear/result error:', error);
      return res.status(500).json({ ok: false, message: 'unable to process sensor clear result' });
    }
  });

  // GET /api/device/sensor/clear/status - Get latest clear status
  router.get('/api/device/sensor/clear/status', (req, res) => {
    return res.json({
      pendingSensorClear: getPendingSensorClear(),
      lastSensorClearStatus: getLastSensorClearStatus(),
    });
  });

  return router;
};
