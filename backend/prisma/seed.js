// One-off bootstrap: creates the first admin account and canonical dispatch regions,
// since there is otherwise no way to log in as an admin (admin accounts are
// intentionally not self-registrable via the public API).
//
// Run with: npm run seed
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { seedDefaultRegions } = require('./default-regions.cjs');

const prisma = new PrismaClient();

async function main() {
  const phone = process.env.SEED_ADMIN_PHONE || '+10000000000';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const fullName = process.env.SEED_ADMIN_NAME || 'Super Admin';

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    console.log(`[seed] Admin with phone ${phone} already exists, skipping.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.create({
      data: {
        role: 'ADMIN',
        phone,
        fullName,
        passwordHash,
        admin: { create: { permissionLevel: 'SUPER' } }
      }
    });
    console.log('[seed] Admin account created:');
    console.log(`  phone:    ${phone}`);
    console.log('  password: [hidden; use the configured SEED_ADMIN_PASSWORD]');
    console.log('  ⚠ Log in and change this password immediately in a real deployment.');
  }

  const regions = await prisma.$transaction(seedDefaultRegions);
  console.log('[seed] Canonical regions:', regions);

  const commissionSetting = await prisma.setting.findUnique({ where: { key: 'commission_rate' } });
  if (!commissionSetting) {
    await prisma.setting.create({
      data: { key: 'commission_rate', value: 0.15, description: 'Комиссия платформы с завершённой поездки (0..1)' }
    });
    console.log('[seed] Created setting commission_rate = 0.15');
  }
}

main()
  .catch((err) => {
    console.error('[seed] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
