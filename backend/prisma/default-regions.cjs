const { Prisma } = require('@prisma/client');
const dataset = require('./data/default-regions.json');

// These are operational dispatch regions approved by the project owner.
// Existing edited geometry always wins over the repository bootstrap defaults.
async function seedDefaultRegions(tx) {
  const result = { created: 0, filled: 0, preserved: 0 };
  for (const region of dataset.regions) {
    const matches = await tx.district.findMany({ where: { OR: [{ id: region.id }, { name: region.name }] } });
    if (matches.length > 1 || (matches.length === 1 && matches[0].name !== region.name)) {
      throw new Error(`Ambiguous default region identity: ${region.name}. Resolve manually before seeding.`);
    }
    const existing = matches[0];
    if (!existing) {
      await tx.district.create({ data: {
        ...region, city: 'Ашхабад', baseFare: 5, perKmRate: 1.5, perMinRate: 0.3
      } });
      result.created++;
    } else if (existing.boundary == null) {
      // Conditional write also preserves a boundary saved after the read above.
      const { count } = await tx.district.updateMany({
        where: { id: existing.id, OR: [{ boundary: { equals: Prisma.DbNull } }, { boundary: { equals: Prisma.JsonNull } }] },
        data: { boundary: region.boundary }
      });
      result.filled += count;
      result.preserved += 1 - count;
    } else {
      result.preserved++;
    }
  }
  return result;
}

module.exports = { seedDefaultRegions };

if (require.main === module) {
  require('dotenv').config();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  prisma.$transaction(seedDefaultRegions)
    .then(result => console.log('[regions] Defaults applied:', result))
    .catch(error => { console.error('[regions] Failed:', error.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
