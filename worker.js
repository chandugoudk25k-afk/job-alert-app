// worker.js
const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// Utility: publish a job match to a user's channel
async function publishMatch(pub, userId, job) {
  const channel = `notifications:${userId}`;
  const payload = JSON.stringify({
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    contract: job.contract,
    ts: Date.now()
  });
  await pub.publish(channel, payload);
}

async function main() {
  const pub = createClient({ url: REDIS_URL });
  pub.on("error", (e) => console.error("Redis pub error:", e));
  await pub.connect();

  console.log("Worker started. Sending mock job alerts every 5s to user 'demo'...");

  // MOCK GENERATOR (replace with your fetch+match pipeline)
  let seq = 1;
  setInterval(async () => {
    const job = {
      id: `job-${seq++}`,
      title: "Java Full-Stack Developer",
      company: "Acme Corp",
      location: "Remote, USA",
      url: "https://example.com/jobs/java-fullstack",
      contract: ["C2C", "W2", "Full-time"][Math.floor(Math.random() * 3)]
    };
    try {
      await publishMatch(pub, "demo", job);
      console.log("Published:", job.id);
    } catch (e) {
      console.error("Publish failed:", e);
    }
  }, 5000);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    try { await pub.quit(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
