export const CourseSessionsTable = (sequelize, Sequelize) => sequelize.define("course_sessions", {
  id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
  tenant_id: { type: Sequelize.STRING, allowNull: false },
  title: { type: Sequelize.STRING, allowNull: false },
  host: { type: Sequelize.STRING, allowNull: false },
  topic: { type: Sequelize.STRING, allowNull: false },
  scheduledMs: { type: Sequelize.DOUBLE, allowNull: false },
  durationMinutes: { type: Sequelize.INTEGER, allowNull: false },
  meetingLink: { type: Sequelize.STRING(2048), allowNull: false },
}, { tableName: "course_sessions", underscored: true, indexes: [{ fields: ["tenant_id"] }] });
