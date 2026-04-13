/**
 * Device Enrollment Routes - ESP32 fingerprint enrollment
 */
const express = require('express');
const router = express.Router();

module.exports = (ClassModel, Student, Attendance, getPendingEnrollment, getLastEnrollmentStatus, setPendingEnrollment, setLastEnrollmentStatus) => {
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

      const pending = getPendingEnrollment();
      if (!pending || requestId !== pending.requestId) {
        return res.status(400).json({ ok: false, message: 'no matching pending enrollment' });
      }

      const isSuccess = successRaw === '1' || successRaw === 'true' || successRaw === 'yes';

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

      const student = await Student.create({
        rollNumber: pending.rollNumber,
        name: pending.name,
        fingerprintId: pending.fingerprintId,
        classId: pending.classId,
      });

      if (pending.classId) {
        await ClassModel.findByIdAndUpdate(pending.classId, { $inc: { studentCount: 1 } }).exec();
      }

      setPendingEnrollment(null);
      setLastEnrollmentStatus({
        state: 'saved',
        requestId,
        message: `Enrollment complete. Student ${student.name} saved with fingerprint ID ${student.fingerprintId}.`,
        student: {
          rollNumber: student.rollNumber,
          name: student.name,
          fingerprintId: student.fingerprintId,
          classId: student.classId,
        },
        at: new Date(),
      });
      return res.json({
        ok: true,
        saved: true,
        message: `Enrollment complete. Student ${student.name} saved with fingerprint ID ${student.fingerprintId}.`,
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

  return router;
};
