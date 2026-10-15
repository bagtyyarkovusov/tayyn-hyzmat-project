// Container-only fixture. Never run against the shared development database.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const url = new URL(process.env.DATABASE_URL);
if (process.env.ISOLATED_ZONE_FIXTURE !== 'true' || url.hostname !== 'db' || url.pathname !== '/tayyn_zone_test') {
  throw new Error('Refusing to seed outside the isolated zone-test database');
}
for (const key of ['SEED_ADMIN_PHONE', 'SEED_ADMIN_PASSWORD', 'SEED_DRIVER_PASSWORD']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const prisma = new PrismaClient();
const zoneId = 'e3519bd4-ab53-4efb-8e1b-0abedc1c0301';

async function main() {
  const adminHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD, 12);
  const driverHash = await bcrypt.hash(process.env.SEED_DRIVER_PASSWORD, 12);
  await prisma.$transaction(async (tx) => {
    // Create only on first run. Rerunning preserves manually edited test geometry.
    await tx.district.upsert({
      where: { id: zoneId }, update: {},
      create: {
        id: zoneId, name: 'TEST ONLY - Central Ashgabat', city: 'Ashgabat',
        centerLat: 37.9601, centerLng: 58.3261, radiusKm: 3,
        boundary: [[[37.94, 58.30], [37.98, 58.30], [37.98, 58.36], [37.94, 58.36], [37.94, 58.30]]],
        baseFare: 5, perKmRate: 1.5, perMinRate: 0.3
      }
    });
    await tx.user.upsert({
      where: { phone: process.env.SEED_ADMIN_PHONE }, update: {},
      create: {
        phone: process.env.SEED_ADMIN_PHONE, fullName: 'Synthetic Dispatcher',
        passwordHash: adminHash, role: 'ADMIN',
        admin: { create: { permissionLevel: 'SUPER' } }
      }
    });
    for (let index = 1; index <= 3; index++) {
      await tx.user.upsert({
        where: { phone: `+1000000010${index}` }, update: {},
        create: {
          phone: `+1000000010${index}`, fullName: `Synthetic Driver ${index}`,
          passwordHash: driverHash, role: 'DRIVER',
          driver: { create: { districtId: zoneId, status: 'APPROVED', approvedAt: new Date() } },
          balance: { create: { amount: 500, currency: 'TMT' } }
        }
      });
    }
    await tx.setting.upsert({
      where: { key: 'commission_rate' }, update: {},
      create: { key: 'commission_rate', value: 0.15, description: 'Synthetic testing only; no real payments' }
    });
  });
  console.log('Isolated fixture ready: one guessed test zone, one dispatcher, three approved drivers with 500 synthetic TMT each. Credentials remain in .local/zone-test.env.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
