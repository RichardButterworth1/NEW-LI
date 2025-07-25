import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json());

const {
  PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_AGENT_ID,
  PORT = 3000,

  // How many ms we allow a *single poll cycle* to run before we give up (per GET /results call)
  MAX_SINGLE_POLL_WAIT_MS = 25000,

  // How often we poll PB in that single cycle (you can also leave it at 0 to just snapshot once)
  POLL_EVERY_MS = 3000,

  // To avoid ResponseTooLargeError in GPT connector
  MAX_RESULTS_RETURNED = 50
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

// ------------------------------------
// Utilities
// ------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildLinkedInSearchUrl(title, company) {
  const q = `${title} "${company}"`;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
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
      JSON.stringify(it); // worst-case fallback
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

// Trim arrays to avoid huge payloads to GPT connector
function truncateArray(arr, max) {
  if (!Array.isArray(arr)) return arr;
  return arr.slice(0, max);
}

// ------------------------------------
// In-memory batches (ok for single-user, ephemeral)
// ------------------------------------
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
 *         containerId: string | null,
 *         status: "running" | "finished" | "aborted" | "error",
 *         resultObject: any | null,
 *         error: string | null
 *       }
 *     }
 *   }
 * }
 */
const batches = Object.create(null);

// ------------------------------------
// PhantomBuster helpers
// ------------------------------------
async function launchRunForTitle(title, company) {
  const linkedInSearchUrl = buildLinkedInSearchUrl(title, company);
  const launchUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/launch`;

  const launchPayload = {
    argument: {
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

// ------------------------------------
// Routes
// ------------------------------------

/**
 * POST /search-profiles
 * Body:
 *  {
 *    "company": "Airbus",
 *    "titles": ["Product Regulatory Manager", ...]   // optional
 *  }
 *
 * Returns immediately:
 *  {
 *    "batchId": "...",
 *    "company": "...",
 *    "titles": [...],
 *    "runs": {
 *      "<title>": { containerId, status, url, error }
 *    }
 *  }
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
        console.log(`🚀 Started PB run for "${title}" (containerId=${containerId})`);
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
 * Poll each still-running run ONCE (or for up to MAX_SINGLE_POLL_WAIT_MS total)
 * and return merged + per-title results (TRUNCATED to avoid oversized responses).
 */
app.get("/results/:batchId", async (req, res) => {
  const { batchId } = req.params;
  const batch = batches[batchId];
  if (!batch) {
    return res.status(404).json({ error: "Unknown batchId" });
  }

  const { runs } = batch;
  const start = Date.now();

  // Poll until time budget exhausted or no runs left in "running"
  while (Date.now() - start < Number(MAX_SINGLE_POLL_WAIT_MS)) {
    let somethingStillRunning = false;

    await Promise.all(
      Object.values(runs).map(async (run) => {
        if (run.status === "running" && run.containerId) {
          const { status, resultObject, error } = await pollSingleRun(run.containerId);

          if (status === "finished") {
            run.status = "finished";
            run.resultObject = resultObject || null;
          } else if (status === "aborted" || status === "error") {
            run.status = status === "error" ? "error" : "aborted";
            run.error = error ? (typeof error === "string" ? error : JSON.stringify(error)) : null;
          } else {
            // still running
            somethingStillRunning = true;
          }
        }
      })
    );

    if (!somethingStillRunning) {
      break;
    }

    // wait before next poll round (if we still have time left)
    if (Date.now() - start + Number(POLL_EVERY_MS) < Number(MAX_SINGLE_POLL_WAIT_MS)) {
      await sleep(Number(POLL_EVERY_MS));
    } else {
      break;
    }
  }

  // Build merged, but TRUNCATE to avoid GPT connector payload size issues
  const mergedRaw = [];
  for (const run of Object.values(runs)) {
    if (run.status === "finished" && run.resultObject) {
      mergedRaw.push(...normalizeToArray(run.resultObject));
    }
  }
  const merged = dedupeByUrl(mergedRaw);
  const truncatedMerged = truncateArray(merged, Number(MAX_RESULTS_RETURNED));

  // Also truncate perTitle result arrays if present
  const perTitle = Object.fromEntries(
    Object.entries(runs).map(([t, r]) => {
      let ro = r.resultObject;
      if (Array.isArray(ro)) {
        ro = ro.slice(0, Number(MAX_RESULTS_RETURNED));
      } else if (ro && Array.isArray(ro?.data)) {
        ro = { ...ro, data: ro.data.slice(0, Number(MAX_RESULTS_RETURNED)) };
      }
      return [
        t,
        {
          status: r.status,
          containerId: r.containerId,
          url: r.url,
          resultObject: ro,
          error: r.error
        }
      ];
    })
  );

  const allFinished = Object.values(runs).every(
    (r) => r.status === "finished" || r.status === "aborted" || r.status === "error"
  );

  return res.json({
    batchId,
    company: batch.company,
    titles: batch.titles,
    allFinished,
    mergedCount: truncatedMerged.length,
    merged: truncatedMerged,
    perTitle
  });
});

app.get("/", (_req, res) => {
  res.send("PhantomBuster LinkedIn fire-and-poll search service is running.");
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
