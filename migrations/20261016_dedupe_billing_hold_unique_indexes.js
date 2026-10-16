/**
 * Repair unique indexes accreted by Sequelize sync({ alter: true }) on hold_id.
 * Run before starting the app when billing_holds has reached MySQL's index limit:
 *   node migrations/20261016_dedupe_billing_hold_unique_indexes.js
 */
import db from "../src/database/index.js";

const TABLE = "billing_holds";
const COLUMN = "hold_id";
const CANONICAL_INDEX = "uq_billing_holds_hold_id";

const escapeIdentifier = (value) => `\`${value.replaceAll("`", "``")}\``;

const uniqueHoldIndexes = async () => {
  const [rows] = await db.sequelize.query(
    `SELECT s.index_name AS name
       FROM information_schema.statistics s
       JOIN (
         SELECT index_name, COUNT(*) AS column_count
           FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = :table
          GROUP BY index_name
       ) i ON i.index_name = s.index_name
      WHERE s.table_schema = DATABASE()
        AND s.table_name = :table
        AND s.column_name = :column
        AND s.non_unique = 0
        AND s.index_name <> 'PRIMARY'
        AND i.column_count = 1
      GROUP BY s.index_name`,
    { replacements: { table: TABLE, column: COLUMN } },
  );
  return rows.map(({ name }) => name);
};

const run = async () => {
  try {
    let indexes = await uniqueHoldIndexes();
    if (!indexes.includes(CANONICAL_INDEX)) {
      const existing = indexes[0];
      if (existing) {
        for (const index of indexes.slice(1)) {
          await db.sequelize.query(
            `ALTER TABLE ${escapeIdentifier(TABLE)} DROP INDEX ${escapeIdentifier(index)}`,
          );
          console.log(`[MIGRATION] dropped duplicate ${index}`);
        }
        await db.sequelize.query(
          `ALTER TABLE ${escapeIdentifier(TABLE)} DROP INDEX ${escapeIdentifier(existing)}, ADD UNIQUE INDEX ${escapeIdentifier(CANONICAL_INDEX)} (${escapeIdentifier(COLUMN)})`,
        );
        console.log(`[MIGRATION] replaced ${existing} with ${CANONICAL_INDEX}`);
      } else {
        await db.sequelize.query(
          `ALTER TABLE ${escapeIdentifier(TABLE)} ADD UNIQUE INDEX ${escapeIdentifier(CANONICAL_INDEX)} (${escapeIdentifier(COLUMN)})`,
        );
        console.log(`[MIGRATION] created ${CANONICAL_INDEX}`);
      }
      indexes = await uniqueHoldIndexes();
    }

    for (const index of indexes) {
      if (index === CANONICAL_INDEX) continue;
      await db.sequelize.query(
        `ALTER TABLE ${escapeIdentifier(TABLE)} DROP INDEX ${escapeIdentifier(index)}`,
      );
      console.log(`[MIGRATION] dropped duplicate ${index}`);
    }

    const remaining = await uniqueHoldIndexes();
    if (remaining.length !== 1 || remaining[0] !== CANONICAL_INDEX) {
      throw new Error(`Expected only ${CANONICAL_INDEX}; found: ${remaining.join(", ") || "none"}`);
    }
    console.log(`[MIGRATION] hold_id unique indexes: ${remaining.join(", ")}`);
    process.exit(0);
  } catch (error) {
    console.error("[MIGRATION] FAILED:", error.message);
    process.exit(1);
  }
};

run();
