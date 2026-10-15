// One-off bootstrap: creates the first admin account and a default district,
// since there is otherwise no way to log in as an admin (admin accounts are
// intentionally not self-registrable via the public API).
//
// Run with: npm run seed
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

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

  // Ashgabat's actual administrative division is 4 etraps (Bagtyýarlyk,
  // Berkararlyk, Köpetdag, Büzmeýin) - not 9. These 9 are operational
  // dispatch zones, not official boundaries: each is a center point, and a
  // driver's current zone is whichever center their live GPS is nearest to
  // (see src/utils/geo.js). Coordinates are approximate, grounded in their
  // known relative position to the city center (37.9601, 58.3261), and are
  // safe to tune later via `districts.centerLat/centerLng` without any code
  // change. Names were replaced at the user's explicit request (2026-08-27)
  // to match informal neighborhood names from a reference app, applied in
  // the same order as the districts this app already had (alphabetically:
  // Багтыярлык→Мир, Беркарарлык→Микрорайон, Бузмейин→"30мкр, Гуртлы",
  // Гарашсызлык→"Хитровка, Бедев", Гуртлы→"Чоганлы, Гарадамак",
  // Копетдаг→Центр, Парахат→"Ачабил, Бекреве", Рухабат→"Анау, Гами",
  // Чоганлы→"Аркадаг, Ялкым") rather than by matching them to each
  // district's actual real-world location - the user picked that mapping
  // explicitly when asked, so e.g. "Центр" is NOT the district whose
  // coordinates are the actual city center below.
  const districts = [
    { name: 'Хитровка, Бедев', city: 'Ашхабад', centerLat: 37.9601, centerLng: 58.3261 }, // центр
    { name: 'Мир', city: 'Ашхабад', centerLat: 37.9780, centerLng: 58.4050 }, // восток
    { name: 'Микрорайон', city: 'Ашхабад', centerLat: 37.9250, centerLng: 58.3550 }, // юг-центр
    { name: 'Центр', city: 'Ашхабад', centerLat: 37.8950, centerLng: 58.3050 }, // юг, у гор
    { name: '30мкр, Гуртлы', city: 'Ашхабад', centerLat: 38.0450, centerLng: 58.2150 }, // северо-запад
    { name: 'Анау, Гами', city: 'Ашхабад', centerLat: 37.9906, centerLng: 58.3253 }, // север-центр
    { name: 'Ачабил, Бекреве', city: 'Ашхабад', centerLat: 37.9300, centerLng: 58.3950 }, // юго-восток
    { name: 'Аркадаг, Ялкым', city: 'Ашхабад', centerLat: 38.0150, centerLng: 58.3400 }, // север
    { name: 'Чоганлы, Гарадамак', city: 'Ашхабад', centerLat: 38.0000, centerLng: 58.2700 } // северо-запад-центр
  ];

  for (const district of districts) {
    const existingDistrict = await prisma.district.findFirst({ where: { name: district.name } });
    if (!existingDistrict) {
      await prisma.district.create({
        data: { ...district, baseFare: 5, perKmRate: 1.5, perMinRate: 0.3 }
      });
      console.log(`[seed] Created district "${district.name}".`);
    }
  }

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
