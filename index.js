import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json());

const {
  PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_AGENT_ID,
  PORT = 3000,
  POLL_EVERY_MS = 5000,   // When *we* poll (GET /results/:batchId) each run
  MAX_WAIT_MS = 180000    // Safety cap for single poll cycle (not used for POST)
} = process.env;

if (!PHANTOMBUSTER_API_KEY || !PHANTOMBUSTER_AGENT_ID) {
  console.error("❌ PHANTOMBUSTER_API_KEY and PHANTOMBUSTER_AGENT_ID must be set.");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "X-Phantombuster-Key-1": PHANTOMBUSTER_API_KEY
};

const DEFAULT_TITLES = [
  "Product Regulatory Manager",
  "Regulatory Compliance Director",
  "Product Stewardship Director",
  "Product Sustainability Director"
];

function buildLinkedInSearchUrl(title, company) {
  const q = `${title} "${company}"`;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

// ---- In-memory store of batches (good enough for single-user) ----
/**
 * batches: {
 *   [batchId]: {
 *     company: string,
 *     titles: string[],
 *     createdAt: number,
 *     runs: {
 *       [title]: {
 *         title: string,
 *         url: string,
 *         containerId: string,
 *         status: "running" | "finished" | "aborted" | "error",
 *         resultObject: any | null,
 *         error: string | null
 *       }
 *     }
 *   }
 * }
 */
const batches = Object.create(null);

/**
 * Launches one PB run for a single title (returns containerId).
 * We don't wait here—non-blocking.
 */
async function launchRunForTitle(title, company) {
  const linkedInSearchUrl = buildLinkedInSearchUrl(title, company);
  const launchUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/launch`;

  const launchPayload = {
    argument: {
      // IMPORTANT: your Phantom must read this singular field
      linkedInSearchUrl
    }
  };

  const launchRes = await axios.post(launchUrl, launchPayload, { headers });
  const data = launchRes.data || {};
  const containerId =
    data.containerId || data.data?.containerId || data.container?.id;

  if (!containerId) {
    throw new Error(`No containerId returned by PB for title "${title}"`);
  }

  return { containerId, url: linkedInSearchUrl };
}

/**
 * Polls a single run for its final status and returns final state.
 * (No fabrication: if resultObject isn't present, we say so.)
 */
async function pollSingleRun(containerId) {
  const outUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/output?containerId=${encodeURIComponent(
    containerId
  )}`;
  try {
    const outRes = await axios.get(outUrl, { headers });
    const out = outRes.data || {};
    const status = out.status || out.data?.status;
    const resultObject = out.resultObject || out.data?.resultObject;

    return { status, resultObject, error: out.error || null };
  } catch (e) {
    return {
      status: "error",
      resultObject: null,
      error: e?.response?.data || e.message || "Unknown error"
    };
  }
}

function normalizeToArray(resultObject) {
  if (!resultObject) return [];
  if (Array.isArray(resultObject)) return resultObject;
  if (Array.isArray(resultObject.data)) return resultObject.data;
  if (Array.isArray(resultObject.results)) return resultObject.results;
  if (Array.isArray(resultObject.profiles)) return resultObject.profiles;
  return [];
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key =
      it.profileUrl ||
      it.url ||
      it.linkedinProfileUrl ||
      it.publicProfileUrl ||
      JSON.stringify(it);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/**
 * POST /search-profiles
 * Starts the runs. Does NOT wait.
 *
 * Body:
 * {
 *   "company": "Airbus",
 *   "titles": ["Product Regulatory Manager", ...] // optional
 * }
 *
 * Response:
 * {
 *   "batchId": "...",
 *   "company": "...",
 *   "titles": [...],
 *   "runs": {
 *     "title": { "containerId": "...", "status": "running" }
 *   }
 * }
 */
app.post("/search-profiles", async (req, res) => {
  const company = (req.body.company || "").trim();
  let titles = Array.isArray(req.body.titles) ? req.body.titles : [];

  if (!company) {
    return res.status(400).json({ error: "Company is required." });
  }
  if (!titles.length) titles = DEFAULT_TITLES;

  const batchId = crypto.randomUUID();
  const createdAt = Date.now();
  batches[batchId] = {
    company,
    titles,
    createdAt,
    runs: {}
  };

  // Launch in parallel, but we’ll collect containerIds before returning.
  await Promise.all(
    titles.map(async (title) => {
      try {
        const { containerId, url } = await launchRunForTitle(title, company);
        batches[batchId].runs[title] = {
          title,
          url,
          containerId,
          status: "running",
          resultObject: null,
          error: null
        };
      } catch (err) {
        console.error(`❌ Launch failed for "${title}":`, err.message || err);
        batches[batchId].runs[title] = {
          title,
          url: null,
          containerId: null,
          status: "error",
          resultObject: null,
          error: err.message || "Unknown error"
        };
      }
    })
  );

  return res.json({
    batchId,
    company,
    titles,
    runs: Object.fromEntries(
      Object.entries(batches[batchId].runs).map(([t, r]) => [
        t,
        { containerId: r.containerId, status: r.status, url: r.url, error: r.error }
      ])
    )
  });
});

/**
 * GET /results/:batchId
 *
 * Polls PhantomBuster for each run status.
 * Returns merged + perTitle (only real, live data).
 *
 * Response:
 * {
 *   "batchId": "...",
 *   "company": "...",
 *   "titles": [...],
 *   "allFinished": boolean,
 *   "mergedCount": number,
 *   "merged": [...],
 *   "perTitle": {
 *     [title]: {
 *       status: "running" | "finished" | "aborted" | "error",
 *       containerId: string | null,
 *       url: string | null,
 *       resultObject: any | null,
 *       error: string | null
 *     }
 *   }
 * }
 */
app.get("/results/:batchId", async (req, res) => {
  const { batchId } = req.params;
  const batch = batches[batchId];
  if (!batch) {
    return res.status(404).json({ error: "Unknown batchId" });
  }

  const { runs } = batch;

  // For each running run, poll its status once.
  await Promise.all(
    Object.values(runs).map(async (run) => {
      if (run.status === "running" && run.containerId) {
        const { status, resultObject, error } = await pollSingleRun(run.containerId);

        if (status === "finished") {
          run.status = "finished";
          run.resultObject = resultObject || null; // never fabricate
        } else if (status === "aborted" || status === "error") {
          run.status = status === "error" ? "error" : "aborted";
          run.error = error ? (typeof error === "string" ? error : JSON.stringify(error)) : null;
        } else {
          // still running
          run.status = "running";
        }
      }
    })
  );

  // Merge only finished runs
  const mergedRaw = [];
  for (const run of Object.values(runs)) {
    if (run.status === "finished" && run.resultObject) {
      mergedRaw.push(...normalizeToArray(run.resultObject));
    }
  }
  const merged = dedupeByUrl(mergedRaw);

  const allFinished = Object.values(runs).every(
    (r) => r.status === "finished" || r.status === "aborted" || r.status === "error"
  );

  return res.json({
    batchId,
    company: batch.company,
    titles: batch.titles,
    allFinished,
    mergedCount: merged.length,
    merged,
    perTitle: Object.fromEntries(
      Object.entries(runs).map(([t, r]) => [
        t,
        {
          status: r.status,
          containerId: r.containerId,
          url: r.url,
          resultObject: r.resultObject,
          error: r.error
        }
      ])
    )
  });
});

app.get("/", (_req, res) => {
  res.send("PhantomBuster LinkedIn multi-title fire-and-poll service is running.");
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
