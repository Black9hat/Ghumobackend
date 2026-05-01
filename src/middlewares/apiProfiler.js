export function apiProfiler(label = "API") {
  return (req, res, next) => {
    try {
      const startHr = process.hrtime.bigint();
      const startCpu = process.cpuUsage();
      const startMem = process.memoryUsage().rss;

      // ✅ ALWAYS initialize safely
      req.__profile = {
        googleMs: 0,
        mongoMs: 0,
      };

      res.on("finish", () => {
        try {
          const endHr = process.hrtime.bigint();
          const endCpu = process.cpuUsage(startCpu);
          const endMem = process.memoryUsage().rss;

          const totalMs = Number(endHr - startHr) / 1e6;
          const cpuMs = (endCpu.user + endCpu.system) / 1000;
          const ramKb = (endMem - startMem) / 1024;
          const bytes = Number(res.getHeader("content-length")) || 0;

          console.log("📊 API PROFILER");
          console.log({
            api: label,
            route: `${req.method} ${req.originalUrl}`,
            total_time_ms: totalMs.toFixed(2),
            cpu_ms: cpuMs.toFixed(2),
            ram_kb: ramKb.toFixed(2),
            data_sent_kb: (bytes / 1024).toFixed(2),
            google_api_ms: req.__profile.googleMs.toFixed(2),
            mongo_ms: req.__profile.mongoMs.toFixed(2),
          });
          console.log("—".repeat(60));
        } catch (logErr) {
          console.error("⚠️ Profiler log error:", logErr.message);
        }
      });

      next(); // ✅ MUST be called
    } catch (err) {
      console.error("❌ Profiler middleware error:", err.message);
      next(); // ✅ never block request
    }
  };
}
