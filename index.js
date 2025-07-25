import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json());

const {
  PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_AGENT_ID,
  PORT = 3000,

  // Fire-and-poll behaviour
  MAX_SINGLE_POLL_WAIT_MS = 25000, // 25s max work per GET /results call
  POLL_EVERY_MS = 3000,            // how often we repoll PB in a single GET /results call
  MAX_RESULTS_RETURNED = 50,       // truncate to avoid ResponseTooLargeError

  // Stagger / retry controls
  LAUNCH_BASE_DELAY_MS = 8000,     // base delay between launches
  LAUNCH_MAX_RETRIES = 5,          // how many times to retry a failed launch (e.g., 429)
  LAUNCH_BACKOFF_FACTOR = 2,       // exponential backoff multiplier
  LAUNCH_JITTER_MS = 1500          // add random jitter to each wait
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

function withJitter(ms) {
  const jitter = Math.floor(Math.random() * Number(LAUNCH_JITTER_MS));
  return ms + jitter;
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
      JSON.stringify(it); // fallback
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

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
      // You can pass additional throttling/limits here if your Phantom supports them, e.g.:
      // numberOfResultsPerLaunch: 25,
      // numberOfResultsPerSearch: 25,
      // delayBetweenRequestsMs: 3000
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
 * Launch with backoff/jitter to handle PB 429s (and other transient failures).
 */
async function launchRunForTitleWithRetry(title, company) {
  let attempt = 0;
  let delay = Number(LAUNCH_BASE_DELAY_MS);

  while (attempt < Number(LAUNCH_MAX_RETRIES)) {
    try {
      const res = await launchRunForTitle(title, company);
      return res;
    } catch (err) {
      attempt += 1;
      const status = err?.response?.status;
      const msg = err?.response?.data || err.message || "Unknown error";
      console.error(`❌ Launch failed for "${title}" (attempt ${attempt}):`, msg);

      if (attempt >= Number(LAUNCH_MAX_RETRIES)) {
        throw new Error(
          `Exceeded max retries (${LAUNCH_MAX_RETRIES}) for title "${title}". Last error: ${msg}`
        );
      }

      // If it's a 429 or 5xx, backoff; for 4xx that aren't 429, it might not help, but we still try.
      if (!status || status >= 500 || status === 429 || status === 408) {
        const wait = withJitter(delay);
        console.log(`⏳ Backing off ${wait}ms before retrying "${title}"...`);
        await sleep(wait);
        delay *= Number(LAUNCH_BACKOFF_FACTOR);
      } else {
        // For other 4xx, backoff less aggressively
        const wait = withJitter(Math.min(delay, 5000));
        console.log(`⏳ Waiting ${wait}ms before retrying "${title}"...`);
        await sleep(wait);
      }
    }
  }

  // Should never get here because we throw above
  throw new Error(`Failed to launch "${title}" after ${LAUNCH_MAX_RETRIES} attempts`);
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
 * Starts runs sequentially with delays & exponential backoff.
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

  // Launch sequentially to respect PB & LinkedIn rate limits
  for (const [idx, title] of titles.entries()) {
    try {
      // small stagger BEFORE launch (except first one)
      if (idx > 0) {
        const wait = withJitter(Number(LAUNCH_BASE_DELAY_MS));
        console.log(`⏳ Waiting ${wait}ms before launching next title...`);
        await sleep(wait);
      }

      const { containerId, url } = await launchRunForTitleWithRetry(title, company);
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
      const msg = err?.response?.data || err.message || "Unknown error";
      console.error(`❌ Final launch failure for "${title}":`, msg);

      batches[batchId].runs[title] = {
        title,
        url: null,
        containerId: null,
        status: "error",
        resultObject: null,
        error: msg
      };
    }
  }

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
 * Polls each still-running run for up to MAX_SINGLE_POLL_WAIT_MS (total).
 * Truncates merged/perTitle arrays to keep payload small.
 */
app.get("/results/:batchId", async (req, res) => {
  const { batchId } = req.params;
  const batch = batches[batchId];
  if (!batch) {
    return res.status(404).json({ error: "Unknown batchId" });
  }

  const { runs } = batch;
  const start = Date.now();

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

    if (Date.now() - start + Number(POLL_EVERY_MS) < Number(MAX_SINGLE_POLL_WAIT_MS)) {
      await sleep(Number(POLL_EVERY_MS));
    } else {
      break;
    }
  }

  const mergedRaw = [];
  for (const run of Object.values(runs)) {
    if (run.status === "finished" && run.resultObject) {
      mergedRaw.push(...normalizeToArray(run.resultObject));
    }
  }

  const merged = dedupeByUrl(mergedRaw);
  const truncatedMerged = truncateArray(merged, Number(MAX_RESULTS_RETURNED));

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
  res.send("PhantomBuster LinkedIn fire-and-poll (staggered) service is running.");
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
