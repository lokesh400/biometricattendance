/**
 * API Routes - Student data API
 */
const express = require('express');
const router = express.Router();

module.exports = (ClassModel, Student) => {
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
  router.post('/api/classes', async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const code = String(req.body.code || '').trim();
      const description = String(req.body.description || '').trim();

      if (!name || !code) {
        return res.status(400).json({ ok: false, message: 'Class name and code are required' });
      }

      const existing = await ClassModel.findOne({ code: code.toUpperCase() }).select('_id').lean();
      if (existing) {
        return res.status(409).json({ ok: false, message: 'Class code already exists' });
      }

      const created = await ClassModel.create({ name, code, description });
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

  return router;
};
