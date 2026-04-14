const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema(
  {
    rollNumber: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    fingerprintId: { type: Number, required: true, unique: true },
    fingerprintTemplateHex: {
      type: String,
      default: '',
      trim: true,
    },
    fingerprintTemplateFormat: {
      type: String,
      default: 'adafruit-template-hex-v1',
      trim: true,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Student', studentSchema);
