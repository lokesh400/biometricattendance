/**
 * Device Migration Routes - backup templates to MongoDB and clear scanner
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

module.exports = (
  Student,
  getPendingMigration,
  getLastMigrationStatus,
  setPendingMigration,
  setLastMigrationStatus,
) => {
  // POST /api/device/migration/start - Start export of all known fingerprint IDs
  router.post('/api/device/migration/start', async (req, res) => {
    try {
      if (getPendingMigration()) {
        return res.status(409).json({ ok: false, message: 'migration already in progress' });
      }

      const students = await Student.find()
        .select('_id rollNumber name fingerprintId')
        .sort({ fingerprintId: 1 })
        .lean();

      if (!students.length) {
        return res.status(400).json({ ok: false, message: 'no students found for migration' });
      }

      const migration = {
        requestId: crypto.randomBytes(8).toString('hex'),
        students,
        currentIndex: 0,
        clearIssued: false,
        createdAt: new Date(),
        results: {
          exported: 0,
          exportFailed: 0,
          exportFailures: [],
          scannerCleared: false,
        },
      };

      setPendingMigration(migration);
      setLastMigrationStatus({
        state: 'pending',
        requestId: migration.requestId,
        total: students.length,
        exported: 0,
        exportFailed: 0,
        scannerCleared: false,
        message: 'Migration started. ESP32 will export templates and then clear scanner memory.',
        at: new Date(),
      });

      return res.json({
        ok: true,
        requestId: migration.requestId,
        total: students.length,
        message: 'Migration started',
      });
    } catch (error) {
      console.error('POST /api/device/migration/start error:', error);
      return res.status(500).json({ ok: false, message: 'unable to start migration' });
    }
  });

  // GET /api/device/migration/next - Get next migration instruction for ESP32
  router.get('/api/device/migration/next', (req, res) => {
    const migration = getPendingMigration();
    if (!migration) {
      return res.type('text/plain').send('NONE');
    }

    if (migration.currentIndex < migration.students.length) {
      const current = migration.students[migration.currentIndex];
      return res
        .type('text/plain')
        .send(`EXPORT|${migration.requestId}|${current.fingerprintId}`);
    }

    if (!migration.clearIssued) {
      migration.clearIssued = true;
      setPendingMigration(migration);
      return res.type('text/plain').send(`CLEAR|${migration.requestId}`);
    }

    return res.type('text/plain').send('WAIT');
  });

  // POST /api/device/migration/result - Receive export/clear result from ESP32
  router.post('/api/device/migration/result', async (req, res) => {
    try {
      const migration = getPendingMigration();
      if (!migration) {
        return res.status(400).json({ ok: false, message: 'no migration in progress' });
      }

      const requestId = String(req.body.requestId || '').trim();
      const action = String(req.body.action || '').trim().toLowerCase();
      const successRaw = String(req.body.success || '').trim().toLowerCase();
      const message = String(req.body.message || '').trim();
      const templateHex = String(req.body.templateHex || '').trim();
      const fingerprintId = Number(req.body.fingerprintId || 0);

      if (requestId !== migration.requestId) {
        return res.status(400).json({ ok: false, message: 'request mismatch' });
      }

      const success = successRaw === '1' || successRaw === 'true' || successRaw === 'yes';

      if (action === 'export') {
        if (migration.currentIndex >= migration.students.length) {
          return res.status(400).json({ ok: false, message: 'no export remaining' });
        }

        const current = migration.students[migration.currentIndex];
        if (Number(current.fingerprintId) !== fingerprintId) {
          return res.status(400).json({ ok: false, message: 'fingerprint id mismatch' });
        }

        if (success && templateHex) {
          await Student.updateOne(
            { _id: current._id },
            {
              $set: {
                fingerprintTemplateHex: templateHex,
                fingerprintTemplateFormat: 'adafruit-template-hex-v1',
              },
            },
          );
          migration.results.exported += 1;
        } else {
          migration.results.exportFailed += 1;
          migration.results.exportFailures.push({
            fingerprintId,
            rollNumber: current.rollNumber,
            name: current.name,
            message: message || 'export failed',
          });
        }

        migration.currentIndex += 1;
        setPendingMigration(migration);

        setLastMigrationStatus({
          state: 'pending',
          requestId: migration.requestId,
          total: migration.students.length,
          processed: migration.currentIndex,
          exported: migration.results.exported,
          exportFailed: migration.results.exportFailed,
          scannerCleared: false,
          message: `Processed ${migration.currentIndex}/${migration.students.length} templates`,
          at: new Date(),
        });

        return res.json({ ok: true });
      }

      if (action === 'clear') {
        if (!success) {
          setLastMigrationStatus({
            state: 'failed',
            requestId: migration.requestId,
            total: migration.students.length,
            processed: migration.currentIndex,
            exported: migration.results.exported,
            exportFailed: migration.results.exportFailed,
            scannerCleared: false,
            message: `Scanner clear failed. ${message || ''}`.trim(),
            at: new Date(),
          });
          return res.status(200).json({ ok: false, message: 'scanner clear failed' });
        }

        migration.results.scannerCleared = true;
        setLastMigrationStatus({
          state: 'completed',
          requestId: migration.requestId,
          total: migration.students.length,
          processed: migration.currentIndex,
          exported: migration.results.exported,
          exportFailed: migration.results.exportFailed,
          scannerCleared: true,
          exportFailures: migration.results.exportFailures,
          message: 'Migration complete. Templates backed up and scanner cleared.',
          at: new Date(),
        });
        setPendingMigration(null);
        return res.json({ ok: true, completed: true });
      }

      return res.status(400).json({ ok: false, message: 'invalid action' });
    } catch (error) {
      console.error('POST /api/device/migration/result error:', error);
      return res.status(500).json({ ok: false, message: 'unable to process migration result' });
    }
  });

  // GET /api/device/migration/status - Get migration status for dashboard/manual checks
  router.get('/api/device/migration/status', (req, res) => {
    res.json({
      pendingMigration: getPendingMigration(),
      lastMigrationStatus: getLastMigrationStatus(),
    });
  });

  return router;
};