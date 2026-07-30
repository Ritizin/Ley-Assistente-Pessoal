import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const mem = process.memoryUsage();
    const toMB = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;

    return {
      status: "ok",
      uptime_s: Math.round(process.uptime()),
      memory_mb: {
        rss: toMB(mem.rss), // consumo real total do processo — meta: < 300MB
        heapUsed: toMB(mem.heapUsed),
        heapTotal: toMB(mem.heapTotal),
        external: toMB(mem.external),
      },
    };
  });
}
