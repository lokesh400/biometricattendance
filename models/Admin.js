const mongoose = require('mongoose');
const passportLocalMongoose = require('passport-local-mongoose').default;

const adminSchema = new mongoose.Schema(
  {
    displayName: {
      type: String,
      default: 'Administrator',
      trim: true,
    },
    role: {
      type: String,
      default: 'admin',
      enum: ['admin'],
    },
  },
  { timestamps: true }
);

adminSchema.plugin(passportLocalMongoose, {
  usernameField: 'username',
});

module.exports = mongoose.model('Admin', adminSchema);
