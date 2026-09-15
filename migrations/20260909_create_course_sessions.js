import db from "../src/database/index.js";

try {
  await db.CourseSessions.sync();
  console.log("Course sessions table ready");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.sequelize.close();
}
