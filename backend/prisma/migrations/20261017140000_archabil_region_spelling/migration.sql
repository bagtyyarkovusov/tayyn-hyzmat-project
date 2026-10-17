-- Correct only the owner-approved canonical spelling. Keep IDs, geometry,
-- tariffs, activation and separately renamed/custom regions unchanged.
-- Reversal, if ever needed, must use a new forward migration.
UPDATE "districts"
SET "name" = 'Арчабил, Бекреве'
WHERE "id" = '6fd3ea19-bcf1-41b3-8af1-df94f62b5f2f'
  AND "name" = 'Ачабил, Бекреве';
