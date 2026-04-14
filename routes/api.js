/**
 * API Routes - Student data API
 */
const express = require('express');
const router = express.Router();

module.exports = (ClassModel, Student) => {
  function isAdminAuthenticated(req) {
    return typeof req.isAuthenticated === 'function' && req.isAuthenticated();
  }

  function requireAdmin(req, res, next) {
    if (isAdminAuthenticated(req)) {
      return next();
    }
    return res.status(401).json({ ok: false, message: 'Admin login required' });
  }

  // GET /api/classes - Get all classes
  router.get('/api/classes', async (req, res) => {
    try {
      const classes = await ClassModel.find().sort({ createdAt: -1 }).lean();
      res.json(classes);
    } catch (error) {
      console.error('GET /api/classes error:', error);
      res.status(500).json({ ok: false, message: 'unable to fetch classes' });
    }
  });

  // POST /api/classes - Create a class
  router.post('/api/classes', requireAdmin, async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const sessionYear = String(req.body.sessionYear || '').trim();

      if (!name || !sessionYear) {
        return res.status(400).json({ ok: false, message: 'Class name and session year are required' });
      }

      const codeBase = `${name}-${sessionYear}`
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toUpperCase();
      const code = codeBase || `CLASS-${Date.now()}`;

      const existing = await ClassModel.findOne({ code }).select('_id').lean();
      if (existing) {
        return res.status(409).json({ ok: false, message: 'A class with this name and session year already exists' });
      }

      const created = await ClassModel.create({ name, sessionYear, code });
      return res.status(201).json({ ok: true, class: created });
    } catch (error) {
      console.error('POST /api/classes error:', error);
      return res.status(500).json({ ok: false, message: 'unable to create class' });
    }
  });

  // GET /api/students - Get all students
  router.get('/api/students', async (req, res) => {
    try {
      const students = await Student.find().sort({ createdAt: -1 }).populate('classId');
      res.json(students);
    } catch (error) {
      console.error('GET /api/students error:', error);
      res.status(500).json({ ok: false, message: 'unable to fetch students' });
    }
  });

  // GET /api/fingerprint-backups - Get enrolled fingerprint templates stored in MongoDB
  router.get('/api/fingerprint-backups', async (req, res) => {
    try {
      const students = await Student.find({
        fingerprintTemplateHex: { $exists: true, $ne: '' },
      })
        .sort({ createdAt: -1 })
        .populate('classId')
        .select('rollNumber name fingerprintId fingerprintTemplateHex fingerprintTemplateFormat classId createdAt');

      res.json({
        ok: true,
        count: students.length,
        students,
      });
    } catch (error) {
      console.error('GET /api/fingerprint-backups error:', error);
      res.status(500).json({ ok: false, message: 'unable to fetch fingerprint backups' });
    }
  });

  return router;
};
