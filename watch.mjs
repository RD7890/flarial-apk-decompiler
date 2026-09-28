#!/usr/bin/env node
// ================================================================
//  Flarial APK Decompiler - GitHub Actions Watcher & Auto-Fixer
//  Watches the build → fetches logs on fail → fixes workflow → loops
//  Downloads artifacts on success → sends Termux notification
// ================================================================

import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import AdmZip from "adm-zip";

const execAsync = promisify(exec);

// ── Config ──────────────────────────────────────────────────────
const TOKEN    = process.env.GH_TOKEN;
if (!TOKEN) { console.error("❌ Set GH_TOKEN env var before running: export GH_TOKEN=your_pat"); process.exit(1); }
const OWNER    = "RD7890";
const REPO     = "flarial-apk-decompiler";
const WORKFLOW = "decompile.yml";
const OUTPUT_DIR = path.resolve(process.env.HOME, "Decompiled");
const POLL_INTERVAL_MS = 20_000;  // poll every 20s
const MAX_FIX_ATTEMPTS = 5;

// ── Colours ─────────────────────────────────────────────────────
const C = {
  reset : "\x1b[0m",
  green : "\x1b[32m",
  red   : "\x1b[31m",
  yellow: "\x1b[33m",
  cyan  : "\x1b[36m",
  bold  : "\x1b[1m",
  dim   : "\x1b[2m",
};

const log  = (msg) => console.log(`${C.cyan}[WATCH]${C.reset} ${msg}`);
const ok   = (msg) => console.log(`${C.green}[  OK  ]${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}[ WARN ]${C.reset} ${msg}`);
const err  = (msg) => console.log(`${C.red}[ FAIL ]${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.dim}        ${msg}${C.reset}`);

// ── Octokit ──────────────────────────────────────────────────────
const octokit = new Octokit({ auth: TOKEN, request: { fetch } });

// ── Helpers ───────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendTermuxNotification(title, body) {
  try {
    execSync(`termux-notification --title "${title}" --content "${body}" --sound --vibrate 500`);
    ok(`Termux notification sent: ${title}`);
  } catch (e) {
    warn(`Could not send Termux notification (termux-api installed?): ${e.message}`);
  }
}

function banner(text) {
  const line = "═".repeat(60);
  console.log(`\n${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}\n`);
}

// ── Trigger workflow ──────────────────────────────────────────────
async function triggerWorkflow() {
  log("Triggering decompile workflow via workflow_dispatch...");
  await octokit.actions.createWorkflowDispatch({
    owner: OWNER, repo: REPO,
    workflow_id: WORKFLOW,
    ref: "main",
  });
  ok("Workflow dispatched!");
  await sleep(5000); // give GitHub a moment to queue it
}

// ── Get latest run ────────────────────────────────────────────────
async function getLatestRun() {
  const { data } = await octokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: WORKFLOW,
    per_page: 1,
  });
  return data.workflow_runs[0] || null;
}

// ── Watch run until completion ─────────────────────────────────────
async function watchRun(runId) {
  banner(`Watching run #${runId}`);
  while (true) {
    const { data: run } = await octokit.actions.getWorkflowRun({
      owner: OWNER, repo: REPO, run_id: runId,
    });

    const status     = run.status;
    const conclusion = run.conclusion;
    const elapsed    = Math.round((Date.now() - new Date(run.created_at)) / 1000);

    process.stdout.write(
      `\r  ${C.yellow}⏳ Status: ${C.bold}${status}${C.reset}${C.yellow}  ` +
      `Elapsed: ${elapsed}s  ${C.dim}(checking every ${POLL_INTERVAL_MS/1000}s)${C.reset}   `
    );

    if (status === "completed") {
      console.log(); // newline after spinner
      return { conclusion, run };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Fetch failed job logs ─────────────────────────────────────────
async function fetchFailedLogs(runId) {
  const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
    owner: OWNER, repo: REPO, run_id: runId,
  });

  let allLogs = "";
  for (const job of jobs.jobs) {
    if (job.conclusion === "failure") {
      err(`Failed job: "${job.name}"`);
      try {
        const { data: logData } = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner: OWNER, repo: REPO, job_id: job.id,
        });
        // logData may be a URL redirect or text
        const logText = typeof logData === "string" ? logData : JSON.stringify(logData);
        // Extract last 100 lines for analysis
        const lines = logText.split("\n");
        const tail = lines.slice(-100).join("\n");
        allLogs += `\n=== JOB: ${job.name} ===\n${tail}\n`;
      } catch (e) {
        warn(`Could not fetch logs for job "${job.name}": ${e.message}`);
      }
    }
  }
  return allLogs;
}

// ── Analyze logs and apply fixes ──────────────────────────────────
async function analyzeAndFix(logs, attempt) {
  warn(`Analyzing failure logs (attempt ${attempt})...`);

  const workflowPath = path.resolve(__dirname, ".github/workflows/decompile.yml");
  let workflow = fs.readFileSync(workflowPath, "utf-8");
  let fixed = false;
  const fixes = [];

  // Fix: Ghidra version not found → try a known stable version
  // Fix: Ghidra action version mismatch — only match the setup-ghidra 'version:' input,
  // NOT the java-version input (which uses 'java-version:' key, so this is safe)
  if (logs.includes("Could not find satisfied version") && logs.includes("setup-ghidra")) {
    workflow = workflow.replace(
      /uses: antoniovazquezblanco\/setup-ghidra@[^\n]+\n(\s+with:\n\s+version: ')[^']+'/,
      "uses: antoniovazquezblanco/setup-ghidra@v2.2.1\n$1'11.3.2'"
    );
    fixes.push("Corrected Ghidra version to 11.3.2 (known supported)");
    fixed = true;
  }

  // Fix: JADX download 404 - roll back version in download URL
  if ((logs.toLowerCase().includes("jadx") || logs.includes("jadx-")) && logs.includes("404")) {
    workflow = workflow.replace(
      /jadx\/releases\/download\/v[\d.]+\/jadx-[\d.]+\.zip/g,
      "jadx/releases/download/v1.5.0/jadx-1.5.0.zip"
    );
    fixes.push("Rolled back JADX download URL to v1.5.0");
    fixed = true;
  }

  // Fix: Apktool download 404
  if (logs.toLowerCase().includes("apktool") && logs.includes("404")) {
    workflow = workflow.replace(
      /apktool\/releases\/download\/v[\d.]+\/apktool_[\d.]+\.jar/g,
      "apktool/releases/download/v2.9.3/apktool_2.9.3.jar"
    );
    workflow = workflow.replace(/apktool_[\d.]+\.jar" -O/g, 'apktool_2.9.3.jar" -O');
    fixes.push("Rolled back Apktool download to v2.9.3");
    fixed = true;
  }

  // Fix: Java heap / OOM
  if (logs.includes("OutOfMemoryError") || logs.includes("Java heap space")) {
    workflow = workflow.replace(/-Xmx\d+g/g, "-Xmx8g");
    fixes.push("Increased Ghidra JVM heap to 8GB");
    fixed = true;
  }

  // Fix: Ghidra script not found in script path
  if (logs.includes("ExportDecompiledC.py") && logs.includes("not found")) {
    workflow = workflow.replace(
      '-scriptPath "$(pwd)/ghidra_scripts"',
      '-scriptPath "$(pwd)/ghidra_scripts" -scriptPath "$(pwd)"'
    );
    fixes.push("Added fallback Ghidra scriptPath");
    fixed = true;
  }

  // Fix: unzip missing
  if (logs.includes("unzip: command not found") || logs.includes("unzip: not found")) {
    if (!workflow.includes("Install unzip")) {
      workflow = workflow.replace(
        "- name: Extract .so files",
        "- name: Install unzip\n        run: sudo apt-get install -y unzip\n\n      - name: Extract .so files"
      );
      fixes.push("Added unzip install step");
      fixed = true;
    }
  }

  // Fix: Permission denied on apktool jar
  if (logs.includes("Permission denied") && logs.toLowerCase().includes("apktool")) {
    workflow = workflow.replace(
      "sudo chmod +x /usr/local/bin/apktool\n",
      "sudo chmod +x /usr/local/bin/apktool\n          sudo chmod 644 /usr/local/bin/apktool.jar\n"
    );
    fixes.push("Fixed apktool jar permissions");
    fixed = true;
  }

  if (fixes.length > 0) {
    fs.writeFileSync(workflowPath, workflow);
    ok(`Applied ${fixes.length} fix(es): ${fixes.join(", ")}`);
    try {
      // Use || true trick so git doesn't crash if nothing changed
      execSync(
        `cd "${__dirname}" && git add .github/workflows/decompile.yml && ` +
        `git diff --cached --quiet || git commit -m "🔧 Auto-fix attempt ${attempt}: ${fixes.join(', ')}" && git push`,
        { stdio: "inherit" }
      );
    } catch (commitErr) {
      warn(`Git note: ${commitErr.message?.slice(0, 120)}`);
    }
    return true;
  }

  warn("No automatic fix matched these errors. Saving logs for manual review...");
  fs.writeFileSync(path.resolve(__dirname, `failure-logs-attempt-${attempt}.txt`), logs);
  err(`Check: failure-logs-attempt-${attempt}.txt`);
  return false;
}

// ── Download artifacts ────────────────────────────────────────────
async function downloadArtifacts(runId) {
  banner("Downloading Decompiled Artifacts");

  const { data: artData } = await octokit.actions.listWorkflowRunArtifacts({
    owner: OWNER, repo: REPO, run_id: runId,
  });

  if (artData.artifacts.length === 0) {
    warn("No artifacts found for this run.");
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const artifact of artData.artifacts) {
    log(`Downloading artifact: ${C.bold}${artifact.name}${C.reset} (${(artifact.size_in_bytes / 1024 / 1024).toFixed(1)} MB)...`);

    // Step 1: Ask GitHub API for the download URL — it returns a 302 redirect
    // to an Azure Blob Storage SAS URL that has its OWN auth embedded in the URL.
    // We must NOT forward the GitHub Authorization header to Azure or it will fail.
    let azureUrl;
    try {
      // octokit follows redirects by default — we need the raw redirect location
      const resp = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${artifact.id}/zip`,
        {
          headers: {
            Authorization: `token ${TOKEN}`,
            Accept: "application/vnd.github.v3+json",
          },
          redirect: "manual", // capture the 302 without following it
        }
      );
      azureUrl = resp.headers.get("location");
      if (!azureUrl) throw new Error("No redirect location in response");
      info(`Redirect URL obtained (${azureUrl.slice(0, 80)}...)`);
    } catch (e) {
      err(`Could not get download URL for ${artifact.name}: ${e.message}`);
      continue;
    }

    // Step 2: Download from Azure WITHOUT Authorization header (SAS URL is self-authenticating)
    const resp = await fetch(azureUrl, { redirect: "follow" });
    if (!resp.ok) throw new Error(`Failed to download: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const zipPath = path.join(OUTPUT_DIR, `${artifact.name}.zip`);
    fs.writeFileSync(zipPath, buffer);

    // Step 3: Extract into named folder
    const extractDir = path.join(OUTPUT_DIR, artifact.name);
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(zipPath);

    ok(`Saved to: ${extractDir}`);
  }

  // Show summary tree
  console.log(`\n${C.bold}📁 Output Directory: ${OUTPUT_DIR}${C.reset}`);
  try {
    const tree = execSync(`find "${OUTPUT_DIR}" -maxdepth 3 -type d`).toString();
    console.log(tree);
  } catch (_) {}
}

// ── Main Loop ─────────────────────────────────────────────────────
async function main() {
  banner("🔬 Flarial APK Decompiler — Auto-Watch & Fix");
  log(`Repo: https://github.com/${OWNER}/${REPO}`);
  log(`Output: ${OUTPUT_DIR}`);
  console.log();

  let fixAttempts = 0;

  // Trigger first run
  await triggerWorkflow();

  while (true) {
    const run = await getLatestRun();
    if (!run) {
      warn("No workflow run found yet. Waiting...");
      await sleep(10000);
      continue;
    }

    log(`Run ID: ${run.id} | URL: ${run.html_url}`);
    const { conclusion } = await watchRun(run.id);

    console.log();

    if (conclusion === "success") {
      banner("✅ BUILD SUCCEEDED!");
      ok("All decompilation jobs passed.");
      await downloadArtifacts(run.id);
      sendTermuxNotification(
        "✅ Flarial Decompilation Done!",
        "All APKs decompiled. Check ~/Decompiled for results."
      );
      break;

    } else {
      err(`Build ${conclusion.toUpperCase()}! (Attempt ${fixAttempts + 1}/${MAX_FIX_ATTEMPTS})`);
      sendTermuxNotification("⚠️ Build Failed", `Attempt ${fixAttempts + 1} failed. Auto-fixing...`);

      if (fixAttempts >= MAX_FIX_ATTEMPTS) {
        err(`Reached max fix attempts (${MAX_FIX_ATTEMPTS}). Stopping.`);
        sendTermuxNotification("❌ Auto-Fix Exhausted", `Failed after ${MAX_FIX_ATTEMPTS} attempts.`);
        process.exit(1);
      }

      const logs = await fetchFailedLogs(run.id);
      const fixed = await analyzeAndFix(logs, ++fixAttempts);

      if (fixed) {
        log("Fix pushed. Waiting for new workflow run to start...");
        await sleep(15000);
        await triggerWorkflow();
      } else {
        err("Cannot auto-fix. Manual review required.");
        process.exit(1);
      }
    }
  }
}

// Store __dirname equivalent for ESM
import { fileURLToPath } from "url";
import { dirname }       from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

main().catch(e => {
  err(`Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
