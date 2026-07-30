import type { FastifyInstance } from "fastify";
import { calendarRoutes } from "./calendar.route.js";

export { calendarService } from "./calendar.service.js";

export async function registerCalendarModule(app: FastifyInstance): Promise<void> {
  await app.register(calendarRoutes);
}
