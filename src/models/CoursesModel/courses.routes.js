import express from "express";
import db from "../../database/index.js";
import { validateSession } from "./sessionValidation.js";
import {
  createCourseController,
  getAllCoursesController,
  getCourseByIdController,
  updateCourseController,
  deleteCourseController,
} from "./courses.controller.js";
import {
  authenticate,
  authorize,
} from "../../middlewares/auth/authMiddlewares.js";
import { checkFeatureAccess } from "../../middlewares/feature/checkFeatureAccess.js";

const Router = express.Router();
const tenantRoles = ["tenant_admin", "staff"];

Router.route("/courses/sessions")
  .all(authenticate, authorize({ user_type: "tenant", roles: tenantRoles }), checkFeatureAccess("courses"))
  .get(async (req, res) => {
    try {
      const data = await db.CourseSessions.findAll({ where: { tenant_id: req.user.tenant_id }, order: [["scheduledMs", "ASC"]] });
      res.json({ data });
    } catch (error) {
      console.error("Error fetching course sessions:", error);
      res.status(500).json({ message: "Unable to load sessions" });
    }
  })
  .post(async (req, res) => {
    const message = validateSession(req.body);
    if (message) return res.status(400).json({ message });
    const { title, host, topic, scheduledMs, durationMinutes, meetingLink } = req.body;
    try {
      const data = await db.CourseSessions.create({ tenant_id: req.user.tenant_id, title: title.trim(), host: host.trim(), topic, scheduledMs, durationMinutes, meetingLink });
      res.status(201).json({ data });
    } catch (error) {
      console.error("Error scheduling course session:", error);
      res.status(500).json({ message: "Unable to schedule session" });
    }
  });

// Create course
Router.post(
  "/courses",
  authenticate,
  authorize({ user_type: "tenant", roles: tenantRoles }),
  checkFeatureAccess("courses"),
  createCourseController
);

// Get all courses
Router.get(
  "/courses",
  authenticate,
  authorize({ user_type: "tenant", roles: tenantRoles }),
  checkFeatureAccess("courses"),
  getAllCoursesController
);

// Get course by ID
Router.get(
  "/courses/:course_id",
  authenticate,
  authorize({ user_type: "tenant", roles: tenantRoles }),
  checkFeatureAccess("courses"),
  getCourseByIdController
);

// Update course
Router.put(
  "/courses/:course_id",
  authenticate,
  authorize({ user_type: "tenant", roles: tenantRoles }),
  checkFeatureAccess("courses"),
  updateCourseController
);

// Delete course
Router.delete(
  "/courses/:course_id",
  authenticate,
  authorize({ user_type: "tenant", roles: tenantRoles }),
  checkFeatureAccess("courses"),
  deleteCourseController
);

export default Router;
