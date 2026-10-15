const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

// --- Access tokens: short-lived signed JWTs, verified locally on every request ---

function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.jwtAccessExpiresIn });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret);
}

// --- Refresh tokens: opaque random strings, stored server-side as a hash so
// they can be revoked/rotated (a signed JWT alone cannot be invalidated
// before it expires, which is unacceptable for a 30-day-lived token) ---

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseDurationToMs(duration) {
  // Minimal parser for strings like "30d", "15m", "12h", "45s".
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 1000 * 60 * 60 * 24 * 30; // fallback: 30 days
  const value = Number(match[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return value * unit;
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  parseDurationToMs
};
